import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import { createCrmStore } from './crm-store.mjs';

const app = express();
app.use(express.json({ limit: '24mb' }));

const PORT = Number(process.env.PORT || 3000);
const API_SECRET = process.env.API_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || './data/auth';

if (!API_SECRET) {
  console.error('API_SECRET is required');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const CRM = createCrmStore(DATA_DIR);

let sock = null;
let status = 'idle';
let latestQr = null;
let latestQrDataUrl = null;
let pairingCode = null;
let lastError = null;
let phoneInUse = null;
let startLock = null;
let restartPending = false;
let reconnectAttempt = 0;

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

async function resolveStoredLids() {
  if (!sock?.signalRepository?.lidMapping) return 0;
  const lids = Object.keys(CRM.state.chats || {}).filter(jid => jid.endsWith('@lid'));
  let total = 0;
  for (let i = 0; i < lids.length; i += 100) {
    const batch = lids.slice(i, i + 100);
    const mappings = await sock.signalRepository.lidMapping.getPNsForLIDs(batch).catch(() => null);
    for (const mapping of mappings || []) {
      CRM.upsertLidMapping(mapping);
      total++;
    }
  }
  return total;
}

async function resolveOutboundJid(jid) {
  const value = String(jid || '');
  const stored = CRM.resolveSendJid(value);
  if (!value.endsWith('@lid') || stored !== value) return stored;

  const mappings = await sock?.signalRepository?.lidMapping?.getPNsForLIDs?.([value]).catch(() => null);
  for (const mapping of mappings || []) CRM.upsertLidMapping(mapping);

  return CRM.resolveSendJid(value);
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
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true
    });

    CRM.attach(sock);
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
        reconnectAttempt = 0;
        latestQr = null;
        latestQrDataUrl = null;
        pairingCode = null;
        lastError = null;
        console.log('[wa] connected successfully');
        CRM.syncGroups(sock).then(n => console.log('[crm] groups synced=' + n)).catch(e => console.error('[crm] group sync failed', e?.message || e));
        setTimeout(() => resolveStoredLids().then(n => console.log('[crm] lid mappings resolved=' + n)).catch(e => console.error('[crm] lid resolve failed', e?.message || e)), 1200);
      }

      if (update.connection === 'close') {
        const error = update.lastDisconnect?.error;
        const code =
          error?.output?.statusCode ||
          error?.data?.statusCode ||
          null;

        console.log(`[wa] connection closed code=${code ?? 'unknown'} mode=${mode}`);

        const loggedOut = code === DisconnectReason.loggedOut;
        const hasSavedSession = !!state?.creds?.registered;
        const shouldReconnect = !loggedOut && hasSavedSession;

        if (shouldReconnect) {
          const immediate = code === DisconnectReason.restartRequired || code === 515;
          const delay = immediate
            ? 0
            : Math.min(60000, 1000 * (2 ** Math.min(reconnectAttempt, 5)));

          status = 'restarting';
          lastError = {
            stage: 'connection',
            code,
            message: error?.message || 'Connection closed',
            loggedOut: false,
            retrying: true,
            retryInMs: delay
          };

          if (!restartPending) {
            restartPending = true;
            reconnectAttempt++;
            const resumePhone = phoneInUse;
            console.log('[wa] transient disconnect: reconnecting with saved credentials in ' + delay + 'ms');

            setTimeout(async () => {
              try {
                while (startLock) await sleep(25);
                restartPending = false;
                await startSession('resume', resumePhone);
              } catch (restartError) {
                lastError = {
                  stage: 'autoReconnect',
                  code,
                  message: restartError?.message || String(restartError),
                  loggedOut: false,
                  retrying: true
                };
                status = 'close';
                restartPending = false;

                const retryDelay = Math.min(60000, 1000 * (2 ** Math.min(reconnectAttempt, 5)));
                setTimeout(() => {
                  if (!restartPending && status !== 'open') {
                    startSession('resume', resumePhone).catch(e => {
                      console.error('[wa] delayed reconnect failed', e?.message || e);
                    });
                  }
                }, retryDelay);
              }
            }, delay);
          }
          return;
        }

        restartPending = false;
        lastError = {
          stage: 'connection',
          code,
          message: error?.message || 'Connection closed',
          loggedOut
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


app.get('/crm/snapshot', secure, (req, res) => {
  const archived = String(req.query.archived || '') === '1';
  const search = String(req.query.search || '');
  const labelId = String(req.query.labelId || '');
  const limit = Math.min(500, Math.max(0, Number(req.query.limit || 0)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const includeMeta = String(req.query.includeMeta ?? '1') !== '0';
  res.json(CRM.snapshot({ archived, search, labelId, limit, offset, includeMeta }));
});

app.get('/crm/messages', secure, (req, res) => {
  const jid = String(req.query.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 120)));
  res.json({ jid, messages: CRM.getMessages(jid, limit) });
});

app.get('/crm/avatar', secure, async (req, res) => {
  const jid = String(req.query.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  if (!sock || status !== 'open') return res.json({ url: null });
  try {
    const url = await sock.profilePictureUrl(jid, 'preview', 5000);
    if (url) CRM.upsertContact({ id: jid, imgUrl: url });
    res.json({ url: url || null });
  } catch {
    res.json({ url: null });
  }
});

app.post('/crm/send', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const text = String(req.body?.text || '').trim();
  if (!jid || !text) return res.status(400).json({ error: 'jid_and_text_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });

  try {
    const targetJid = await resolveOutboundJid(jid);
    if (jid.endsWith('@lid') && targetJid === jid) {
      return res.status(409).json({ error: 'contact_number_still_syncing' });
    }
    const sent = await sock.sendMessage(targetJid, { text });
    if (sent) CRM.upsertMessage(sent);
    res.json({ ok: true, messageId: sent?.key?.id || null, resolved: targetJid !== jid });
  } catch (error) {
    console.error('[crm] send failed', {
      jid,
      message: error?.message || String(error)
    });
    res.status(502).json({
      error: 'whatsapp_send_failed',
      detail: error?.message || String(error)
    });
  }
});

app.post('/crm/send-media', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const kind = String(req.body?.kind || '');
  const dataBase64 = String(req.body?.dataBase64 || '');
  const mimetype = String(req.body?.mimetype || 'application/octet-stream');
  const fileName = String(req.body?.fileName || 'arquivo').slice(0, 180);
  const caption = String(req.body?.caption || '').slice(0, 2000);
  const ptt = !!req.body?.ptt;

  if (!jid || !['image','document','audio'].includes(kind) || !dataBase64) {
    return res.status(400).json({ error: 'invalid_media_payload' });
  }
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });

  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length || buffer.length > 16 * 1024 * 1024) {
    return res.status(413).json({ error: 'media_too_large', maxBytes: 16777216 });
  }

  let content;
  if (kind === 'image') content = { image: buffer, mimetype, caption };
  if (kind === 'document') content = { document: buffer, mimetype, fileName, caption };
  if (kind === 'audio') content = { audio: buffer, mimetype, ptt };

  try {
    const targetJid = await resolveOutboundJid(jid);
    if (jid.endsWith('@lid') && targetJid === jid) {
      return res.status(409).json({ error: 'contact_number_still_syncing' });
    }
    const sent = await sock.sendMessage(targetJid, content);
    if (sent) CRM.upsertMessage(sent);
    res.json({ ok: true, messageId: sent?.key?.id || null, resolved: targetJid !== jid });
  } catch (error) {
    console.error('[crm] media send failed', {
      jid,
      kind,
      message: error?.message || String(error)
    });
    res.status(502).json({
      error: 'whatsapp_send_failed',
      detail: error?.message || String(error)
    });
  }
});

app.post('/crm/read', secure, (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  CRM.markReadLocal(jid);
  res.json({ ok: true });
});

app.post('/crm/presence', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    await sock.presenceSubscribe(jid);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'presence_subscribe_failed', message: error?.message || String(error) });
  }
});

app.post('/crm/resync', secure, async (_req, res) => {
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  const collections = ['critical_unblock_low','regular_high','regular_low','critical_block','regular'];
  await sock.resyncAppState(collections, true);
  const groups = await CRM.syncGroups(sock).catch(() => 0);
  res.json({ ok: true, groups });
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
  setTimeout(() => {
    startSession('resume').catch(error => {
      console.error('[wa] automatic resume failed', error?.message || error);
    });
  }, 1000);
});
