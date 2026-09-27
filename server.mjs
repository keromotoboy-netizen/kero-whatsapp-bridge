import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';

const app = express();
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 3000);
const API_SECRET = process.env.API_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || './data/auth';

if (!API_SECRET) {
  console.error('API_SECRET is required');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

let sock = null;
let status = 'idle';
let latestQr = null;
let latestQrDataUrl = null;
let pairingCode = null;
let lastError = null;
let phoneInUse = null;
let startLock = null;
let restartPending = false;

function secure(req, res, next) {
  const provided = req.get('x-api-key') || '';
  if (provided !== API_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function publicState() {
  return {
    status,
    connected: status === 'open',
    hasQr: !!latestQrDataUrl,
    qr: latestQrDataUrl || null,
    pairingCode: pairingCode || null,
    phone: phoneInUse || null,
    lastError
  };
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopSocket() {
  try {
    if (sock?.ws) sock.ws.close();
  } catch {}
  try {
    if (sock?.end) sock.end(new Error('restart'));
  } catch {}
  sock = null;
  await sleep(500);
}

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(250);
  }
  return false;
}

async function startSession(mode, phone = null) {
  if (startLock) return startLock;
  startLock = (async () => {
    const freshPairing = mode === 'qr' || mode === 'phone';
    if (freshPairing && status === 'open') return publicState();
    await stopSocket();
    if (freshPairing) {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log('[wa] cleared stale auth before fresh pairing');
    }
    status = 'starting';
    latestQr = null;
    latestQrDataUrl = null;
    pairingCode = null;

    lastError = null;
    phoneInUse = phone;

    const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);
    const { version } = await fetchLatestBaileysVersion();
    let pairingRequested = false;

    sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'warn' }),
      browser: ['Kero CRM', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      if (update.connection) status = update.connection;

      if (update.qr) {
        latestQr = update.qr;
        latestQrDataUrl = await QRCode.toDataURL(update.qr, {
          width: 720,
          margin: 2
        });

        if (mode === 'phone' && phone && !pairingRequested) {
          pairingRequested = true;
          try {
            pairingCode = await sock.requestPairingCode(phone);
          } catch (error) {
            lastError = {
              stage: 'requestPairingCode',
              message: error?.message || String(error)
            };
          }
        }
      }

      if (update.connection === 'open') {
        status = 'open';
        restartPending = false;
        latestQr = null;
        latestQrDataUrl = null;
        pairingCode = null;
        lastError = null;
        console.log('[wa] connected successfully');
      }

      if (update.connection === 'close') {
        const error = update.lastDisconnect?.error;
        const code =
          error?.output?.statusCode ||
          error?.data?.statusCode ||
          null;

        console.log(`[wa] connection closed code=${code ?? 'unknown'} mode=${mode}`);

        if (code === DisconnectReason.restartRequired || code === 515) {
          status = 'restarting';
          lastError = null;

          if (!restartPending) {
            restartPending = true;
            const resumePhone = phoneInUse;
            console.log('[wa] restartRequired (515): reconnecting immediately with saved credentials');
            setTimeout(async () => {
              try {
                while (startLock) await sleep(25);
                restartPending = false;
                await startSession('resume', resumePhone);
              } catch (restartError) {
                lastError = {
                  stage: 'restartRequired',
                  code: 515,
                  message: restartError?.message || String(restartError)
                };
                status = 'close';
                restartPending = false;
              }
            }, 0);
          }
          return;
        }

        restartPending = false;
        lastError = {
          stage: 'connection',
          code,
          message: error?.message || 'Connection closed',
          loggedOut: code === DisconnectReason.loggedOut
        };
        status = 'close';
      }
    });

    if (mode === 'phone') {
      await waitFor(() => !!pairingCode || status === 'open' || !!lastError);
    } else {
      await waitFor(() => !!latestQrDataUrl || status === 'open' || !!lastError);
    }
    return publicState();
  })();

  try {
    return await startLock;
  } finally {
    startLock = null;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kero-whatsapp-bridge' });
});

app.get('/status', secure, (_req, res) => {
  res.json(publicState());
});

app.get('/qr', secure, (_req, res) => {
  res.json({
    ...publicState(),
    qr: latestQrDataUrl
  });
});

app.post('/connect/qr', secure, async (_req, res) => {
  try {
    const result = await startSession('qr');
    res.json({ ...result, qr: latestQrDataUrl });
  } catch (error) {
    res.status(500).json({
      error: 'qr_start_failed',
      message: error?.message || String(error)
    });
  }
});

app.post('/connect/phone', secure, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: 'invalid_phone' });
  }

  try {
    const result = await startSession('phone', phone);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'phone_start_failed',
      message: error?.message || String(error)
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kero WhatsApp Bridge listening on ${PORT}`);
});
