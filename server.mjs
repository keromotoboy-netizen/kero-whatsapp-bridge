import express from 'express';
import makeWASocket, {
  downloadMediaMessage,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  extractSyncdPatches, decodeSyncdSnapshot, decodePatches, decodeSyncdMutations, proto, BufferJSON, generateWAMessageFromContent
} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createCrmStore } from './crm-store.mjs';
import { createOutboxWorker, parseAllowedJids } from './outbox-worker.mjs';
import { createD1Mirror } from './d1-mirror.mjs';
import { createMediaUploader } from './media-r2.mjs';
import { createAiEngine } from './ai-engine.mjs';
import { selectAuthDirectory } from './auth-directory.mjs';
import { maintenanceMutationAllowed, scheduledMaintenanceAllowed } from './maintenance-permissions.mjs';
import { mountArchivedGroupCleanup } from './archived-group-cleanup.mjs';
import { createCrmArchivedCleanup } from './archived-cleanup-service.mjs';


// KERO-CEO-PAUSE-UNTIL-ORDER-20261104-v1: no timer or automatic release.
export function ceoPauseDecision(action, body = {}) {
  if(action==='react')return {ok:false,error:'ceo_pause_until_further_order',suppressed:'ceo_indefinite_reaction_pause',reacted:false,resumes_at:null,resume_requires:'explicit_ceo_order'};
  if(action==='send-media' && (/^(image|video)$/i.test(String(body.kind||'')) || /^(image|video)\//i.test(String(body.mimetype||''))))return {ok:false,error:'ceo_pause_until_further_order',pulado:'ceo-indefinite-photo-pause',photoBlocked:true,resumes_at:null,resume_requires:'explicit_ceo_order'};
  return null;
}

const app = express();
app.use(express.json({ limit: '24mb' }));
// KERO-ORIGEM-20261108 (CEO 08/11, item 18): toda mensagem NOSSA ganha origem. 'ia' = atendente (cabecalho x-kero-origem: ia),
// 'api' = qualquer outro cliente desta API (painel, scripts), 'humano' = digitada no aparelho (nao passou por aqui).
// Nunca muda o que e enviado; so etiqueta. ORIGEM_ENVIO guarda id -> origem dos ultimos envios para o store consultar.
const ORIGEM_REQ = new AsyncLocalStorage(), ORIGEM_ENVIO = new Map();
app.use((req, res, next) => {
  const bruto = String(req.get('x-kero-origem') || req.body?.origem || 'api').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 20);
  ORIGEM_REQ.run(bruto || 'api', next);
});
function marcarOrigem(sent) {
  const id = sent?.key?.id; if (!id) return;
  ORIGEM_ENVIO.set(String(id), ORIGEM_REQ.getStore() || 'api');
  while (ORIGEM_ENVIO.size > 5000) ORIGEM_ENVIO.delete(ORIGEM_ENVIO.keys().next().value);
}

const PORT = Number(process.env.PORT || 3000);
const API_SECRET = process.env.API_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || './data/auth';

if (!API_SECRET) {
  console.error('API_SECRET is required');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
// KERO 20/10/2026 (CRM etapa 3): CRM_D1_MIRROR=1 grava em dobro conversas/mensagens no D1 (usa a mesma fila Cloudflare).
const d1Mirror = process.env.CRM_D1_MIRROR === '1' && process.env.KERO_QUEUE_URL && process.env.KERO_QUEUE_TOKEN
  ? createD1Mirror({ queueUrl: process.env.KERO_QUEUE_URL, queueToken: process.env.KERO_QUEUE_TOKEN, dailyCap: Number(process.env.CRM_D1_DAILY_CAP || 40000) })
  : null;
// KERO 20/10/2026 (CRM etapa 5): CRM_MEDIA_R2=1 manda a mídia completa das mensagens novas ao R2 (via Worker).
const mediaR2 = process.env.CRM_MEDIA_R2 === '1' && process.env.KERO_QUEUE_URL && process.env.KERO_QUEUE_TOKEN
  ? createMediaUploader({ queueUrl: process.env.KERO_QUEUE_URL, queueToken: process.env.KERO_QUEUE_TOKEN,
      dailyCap: Number(process.env.CRM_MEDIA_DAILY_CAP || 1500),
      download: raw => downloadMediaMessage(raw, 'buffer', {}, { reuploadRequest: sock?.updateMediaMessage, logger: pino({ level: 'silent' }) }) })
  : null;
// KERO-PONTE-PARIDADE-31-10-20261105-v1: midia (da ponte de 31/10)
// KERO 23/10/2026: guarda na memoria as ultimas midias recebidas (so a mensagem, sem o arquivo) para o atendente
// baixar direto do WhatsApp por GET /crm/media/raw, mesmo com o envio ao R2 desligado. Nada vai para o disco.
const mediaRaw = new Map();
// KERO 27/10/2026: a ponte reiniciava e as fotos dos motoboys sumiam (501 falhas "404" num dia). Agora a MENSAGEM da midia
// (so as chaves para baixar do WhatsApp, nunca o arquivo) tambem vai para o disco, por 3 dias.
const MIDIA_DIR = DATA_DIR.replace(/[\/]+$/, '') + '-midia';
try { fs.mkdirSync(MIDIA_DIR, { recursive: true }); } catch {}
const guardarMidiaDisco = (id, raw) => { try { fs.writeFileSync(MIDIA_DIR + '/' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '.json', JSON.stringify(raw, BufferJSON.replacer)); } catch {} };
const lerMidiaDisco = id => { try { return JSON.parse(fs.readFileSync(MIDIA_DIR + '/' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '.json', 'utf8'), BufferJSON.reviver); } catch { return null; } };
setInterval(() => { try { for (const f of fs.readdirSync(MIDIA_DIR)) { const p = MIDIA_DIR + '/' + f; if (Date.now() - fs.statSync(p).mtimeMs > 3 * 86400e3) fs.unlinkSync(p); } } catch {} }, 3600e3).unref?.();
const MEDIA_RAW_MAX = Number(process.env.CRM_MEDIA_RAW_MAX || 400);
const lembrarMidia = (raw, jid, media) => {
  const id = raw?.key?.id; if (id) { mediaRaw.delete(id); mediaRaw.set(id, raw); if (mediaRaw.size > MEDIA_RAW_MAX) mediaRaw.delete(mediaRaw.keys().next().value); guardarMidiaDisco(id, raw); }
  return mediaR2 ? mediaR2.enqueue(raw, jid, media) : null;
};
const CRM = createCrmStore(DATA_DIR, { mirror: d1Mirror, onMedia: lembrarMidia, origemDe: id => ORIGEM_ENVIO.get(String(id)) || null });
if (mediaR2) console.log('[media-r2] ligado');
if (d1Mirror) {
  setInterval(() => { d1Mirror.flush().catch(() => null); }, Number(process.env.CRM_D1_INTERVAL_MS || 5000));
  console.log('[d1-mirror] ligado');
}

// KERO-MEDIA-IDEMPOTENCY-20261104-V2: permanent per-recipient image history.
// SQLite is on the pre-existing auth volume; no image bytes or destination JIDs in the database.
// This never expires entries. Unsafe or uncertain delivery fails closed.
const IMAGE_SEND_DEDUP_PATH = DATA_DIR + '/kero-image-send-dedup-v2.sqlite';
const IMAGE_SEND_DEDUP_LEGACY = DATA_DIR + '/kero-image-send-dedup-v1.json';
let imageSendDedupReady = true;
let imageSendDedupDb = null;
let imageDedupSelect, imageDedupInsert, imageDedupConfirm;
try {
  imageSendDedupDb = new DatabaseSync(IMAGE_SEND_DEDUP_PATH);
  imageSendDedupDb.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  imageSendDedupDb.exec("CREATE TABLE IF NOT EXISTS image_history (fingerprint TEXT PRIMARY KEY CHECK(length(fingerprint)=64), state TEXT NOT NULL CHECK(state IN ('pending','sent')), message_id TEXT, first_seen_ms INTEGER NOT NULL) STRICT;");
  fs.chmodSync(IMAGE_SEND_DEDUP_PATH, 0o600);
  imageDedupSelect = imageSendDedupDb.prepare('SELECT state, message_id FROM image_history WHERE fingerprint=?');
  imageDedupInsert = imageSendDedupDb.prepare("INSERT OR IGNORE INTO image_history(fingerprint,state,message_id,first_seen_ms) VALUES (?,'pending',NULL,?)");
  imageDedupConfirm = imageSendDedupDb.prepare("UPDATE image_history SET state='sent', message_id=? WHERE fingerprint=? AND state='pending'");
  // Retain ALL V1 entries, including those whose 24h TTL has passed; never prune prior receipts.
  if (fs.existsSync(IMAGE_SEND_DEDUP_LEGACY)) {
    const saved = JSON.parse(fs.readFileSync(IMAGE_SEND_DEDUP_LEGACY, 'utf8'));
    if (!Array.isArray(saved)) throw Error('legacy_dedup_store_shape');
    imageSendDedupDb.exec('BEGIN IMMEDIATE');
    try {
      const migrate = imageSendDedupDb.prepare('INSERT OR IGNORE INTO image_history(fingerprint,state,message_id,first_seen_ms) VALUES (?,?,?,?)');
      for (const [key, value] of saved) {
        if (!/^[0-9a-f]{64}$/.test(key) || !value || !['pending','sent'].includes(value.state)) throw Error('legacy_dedup_entry_invalid');
        migrate.run(key, value.state, value.messageId || null, Number.isSafeInteger(value.expiresAt) ? value.expiresAt - 86400000 : Date.now());
      }
      imageSendDedupDb.exec('COMMIT');
    } catch (error) { imageSendDedupDb.exec('ROLLBACK'); throw error; }
  }
} catch (error) {
  imageSendDedupReady = false;
  console.error('[media-dedup] permanent store unavailable; image sends disabled', error?.code || error?.message || 'invalid_data');
}
function imageSendDedupKey(targetJid, buffer) {
  return createHmac('sha256', API_SECRET).update(targetJid).update('\0').update(buffer).digest('hex');
}
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

// Dedicated CEO-authorized one-off operation. Never calls generic maintenance.
const archivedGroupCleanup=createCrmArchivedCleanup({
  getConnection:()=>status==='open'?sock:null,
  readState:()=>CRM.state,
  sdk:{extractSyncdPatches,decodeSyncdSnapshot,decodePatches,decodeSyncdMutations,proto}
});
mountArchivedGroupCleanup(app,secure,archivedGroupCleanup);

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

async function sendCrmText(jid, text) {
  const value = String(jid || '');
  const message = String(text || '').trim();
  if (!value || !message) throw new Error('jid_and_text_required');
  if (!sock || status !== 'open') throw new Error('whatsapp_not_connected');

  const targetJid = await resolveOutboundJid(value);
  if (value.endsWith('@lid') && targetJid === value) {
    throw new Error('contact_number_still_syncing');
  }

  const sent = await sock.sendMessage(targetJid, { text: message });
  if (sent) { marcarOrigem(sent); CRM.upsertMessage(sent); }
  return { ok: true, messageId: sent?.key?.id || null, resolved: targetJid !== value };
}

// KERO-PONTE-PARIDADE-31-10-20261105-v1: cartao Pix (da ponte de 31/10)
async function sendCrmPix(jid, { chave, tipo = 'CNPJ', nome, valor, referencia, formato = 'biz' } = {}) {
  if (!sock || status !== 'open') throw new Error('whatsapp_not_connected');
  if (!jid || !chave || !nome) throw new Error('jid_chave_nome_required');
  const targetJid = await resolveOutboundJid(String(jid));
  const centavos = Math.round(Number(valor || 0) * 100);
  // 26/10: copia EXATA do cartao que o celular manda pela resposta rapida "/Pix" (capturado em cartoes-pix.jsonl):
  // um item vazio, flow_type APPSWITCH e referral quick_reply. Sem isso o WhatsApp descartava o cartao.
  const zero = { value: centavos, offset: 100 };
  const params = {
    currency: 'BRL',
    total_amount: zero,
    reference_id: String(referencia || Math.random().toString(36).slice(2, 13)).toUpperCase().slice(0, 11),
    type: 'physical-goods',
    order: { status: 'pending', subtotal: zero, order_type: 'ORDER', items: [{ name: '', amount: zero, quantity: 0, sale_amount: zero }] },
    payment_settings: [{ type: 'pix_static_code', pix_static_code: { merchant_name: String(nome), key: String(chave), key_type: String(tipo).toUpperCase(), flow_type: 'APPSWITCH' } }],
    share_payment_status: false,
    is_soft_deleted: false,
    referral: 'quick_reply'
  };
  const content = { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'payment_info', buttonParamsJson: JSON.stringify(params) }] } } };
  // formato 'exato' = reenvia o ultimo cartao capturado do celular (cartoes-pix.jsonl) sem mudar nada, so com id novo
  if (formato === 'exato') {
    const linhas = fs.readFileSync(DATA_DIR + '/cartoes-pix.jsonl', 'utf8').trim().split('\n');
    const cap = JSON.parse(linhas.at(-1)).message;
    const m2 = generateWAMessageFromContent(targetJid, proto.Message.fromObject(cap), { userJid: sock.user?.id });
    await sock.relayMessage(targetJid, m2.message, { messageId: m2.key.id });
    return { ok: true, messageId: m2.key.id, formato };
  }
  const msg = generateWAMessageFromContent(targetJid, content, { userJid: sock.user?.id });
  // formato 'biz' (padrao) = com a marcacao de mensagem interativa do Business; 'cru' = sem ela
  const extra = formato === 'cru' ? {} : { additionalNodes: [{ tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'payment_info' } }] }] }] };
  await sock.relayMessage(targetJid, msg.message, { messageId: msg.key.id, ...extra });
  marcarOrigem(msg); CRM.upsertMessage({ key: msg.key, message: { conversation: `[Chave Pix] ${nome} ${tipo}: ${chave}` }, messageTimestamp: Math.floor(Date.now() / 1000) });
  return { ok: true, messageId: msg.key.id };
}


const AI = createAiEngine({
  dataDir: DATA_DIR,
  crm: CRM,
  sendText: sendCrmText
});

async function stopSocket() {
  // A deliberately closed old socket must not overwrite the new pairing status.
  sock?.ev?.removeAllListeners('connection.update');
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
    const authDir = selectAuthDirectory(DATA_DIR, {
      freshPairing,
      loggedOut: lastError?.loggedOut === true && Number(lastError?.code) === 401
    });
    await stopSocket();
    status = 'starting';
    latestQr = null;
    latestQrDataUrl = null;
    pairingCode = null;

    lastError = null;
    phoneInUse = phone;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
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
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages || []) {
        AI.handleIncoming(message).catch(error => {
          console.error('[ai] incoming handler failed', error?.message || error);
        });
      }
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
        const hasPersistedCredentials = fs.existsSync(authDir + '/creds.json');
        const shouldReconnect =
          !loggedOut &&
          (mode === 'resume' || hasSavedSession || hasPersistedCredentials);

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
  const archived = ['1', 'true', 'yes'].includes(String(req.query.archived || '').toLowerCase());
  const search = String(req.query.search || '');
  const labelId = String(req.query.labelId || '');
  const limit = Math.min(500, Math.max(0, Number(req.query.limit || 0)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const metaValue = req.query.includeMeta ?? req.query.meta ?? '1';
  const includeMeta = !['0', 'false', 'no'].includes(String(metaValue).toLowerCase());
  res.json(CRM.snapshot({ archived, search, labelId, limit, offset, includeMeta }));
});

app.get('/crm/messages', secure, (req, res) => {
  const jid = String(req.query.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 120)));
  const before = Math.max(0, Number(req.query.before || 0));
  const offset = Math.max(0, Number(req.query.offset || 0));
  res.json({ jid, ...CRM.getMessages(jid, { limit, before, offset }) });
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

  try {
    res.json(await sendCrmText(jid, text));
  } catch (error) {
    const code = error?.message === 'whatsapp_not_connected' || error?.message === 'contact_number_still_syncing'
      ? 409
      : 502;
    console.error('[crm] send failed', {
      jid,
      message: error?.message || String(error)
    });
    res.status(code).json({
      error: error?.message || 'whatsapp_send_failed'
    });
  }
});

app.post('/crm/send-media', secure, async (req, res) => {
  const ceoPause = ceoPauseDecision('send-media', req.body);
  if (ceoPause) return res.status(423).json(ceoPause);
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
    let dedupKey = null;
    if (kind === 'image') {
      if (!imageSendDedupReady) return res.status(503).json({ error: 'image_dedup_unavailable' });
      dedupKey = imageSendDedupKey(targetJid, buffer);
      try {
        const reservation = imageDedupInsert.run(dedupKey, Date.now());
        if (reservation.changes === 0) {
          const prev = imageDedupSelect.get(dedupKey);
          if (!prev || prev.state === 'pending')
            return res.status(409).json({ error: 'image_delivery_uncertain', duplicate: true });
          return res.json({ ok: true, duplicate: true, suppressed: 'image_already_sent',
            messageId: prev.message_id || null, resolved: targetJid !== jid });
        }
      } catch (error) {
        imageSendDedupReady = false;
        console.error('[media-dedup] permanent reservation failed', error?.code || 'storage_error');
        return res.status(503).json({ error: 'image_dedup_unavailable' });
      }
    }
    const sent = await sock.sendMessage(targetJid, content);
    if (dedupKey) {
      if (!sent?.key?.id) throw Error('media_delivery_uncertain');
      try {
        const receipt = imageDedupConfirm.run(sent.key.id, dedupKey);
        if (receipt.changes !== 1) throw Error('receipt_update_missing');
      } catch (error) {
        imageSendDedupReady = false;
        console.error('[media-dedup] post-send receipt failed; next images blocked',
          error?.code || 'storage_error');
      }
    }
    if (sent) { marcarOrigem(sent); CRM.upsertMessage(sent); }
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

// KERO 21/10/2026: "digitando..." imediato para o atendente (sem passar pela fila).
app.post('/crm/typing', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const state = req.body?.state === 'paused' ? 'paused' : 'composing';
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    await sock.sendPresenceUpdate(state, await resolveOutboundJid(jid));
    res.json({ ok: true, state });
  } catch (error) {
    res.status(502).json({ error: 'presence_update_failed', message: error?.message || String(error) });
  }
});

// KERO 22/10/2026: reacao com emoji na mensagem do cliente (a equipe ve que a IA leu). emoji vazio remove a reacao.
app.post('/crm/react', secure, async (req, res) => {
  const ceoPause = ceoPauseDecision('react', req.body);
  if (ceoPause) return res.status(423).json(ceoPause);
  const jid = String(req.body?.jid || '');
  const id = String(req.body?.id || '');
  const emoji = String(req.body?.emoji ?? '❤️').slice(0, 8);
  if (!jid || !id) return res.status(400).json({ error: 'jid_and_id_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    const key = { remoteJid: targetJid, id, fromMe: !!req.body?.fromMe, ...(req.body?.participant ? { participant: String(req.body.participant) } : {}) };
    await sock.sendMessage(targetJid, { react: { text: emoji, key } });
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'react_failed', message: error?.message || String(error) });
  }
});

// KERO-PONTE-APAGAR-FAVORITAR-20261105-v1: CEO 05/11/2026 "nao dispare nunca nenhum sem favoritar". Rotas da ponte de 31/10, sem mudanca de comportamento.
// Apagar PARA TODOS uma mensagem enviada pela Kero. Resposta 200 = o WhatsApp aceitou o pedido de apagar.
app.post('/crm/delete', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const id = String(req.body?.id || '');
  if (!jid || !id) return res.status(400).json({ error: 'jid_and_id_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    const sent = await sock.sendMessage(targetJid, { delete: { remoteJid: targetJid, id, fromMe: true } });
    CRM.marcarKeroSentApagada(targetJid, id);
    res.json({ ok: true, deleted: id, revokeId: sent?.key?.id || null });
  } catch (error) {
    res.status(502).json({ error: 'delete_failed', message: error?.message || String(error) });
  }
});

// KERO-ROBO-VARREDURA-20261105: SO LEITURA. Mensagens enviadas pela Kero em grupos (inclusive arquivados e do celular),
// ultimas N horas (max 62). Usada pelo robo independente de varredura de O.S. Nao guarda nem devolve mensagem de terceiros.
app.get('/crm/kero-sent', secure, (req, res) => {
  res.json({ ok: true, ...CRM.keroSent({ sinceHours: Number(req.query.sinceHours || 58) }) });
});
// Favoritar (estrela) uma mensagem: dupla seguranca para a equipe achar e apagar pelos Favoritos.
app.post('/crm/star', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const id = String(req.body?.id || '');
  if (!jid || !id) return res.status(400).json({ error: 'jid_and_id_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    const star = req.body?.star !== false;
    await sock.chatModify({ star: { messages: [{ id, fromMe: req.body?.fromMe !== false }], star } }, targetJid);
    res.json({ ok: true, starred: star, id });
  } catch (error) {
    res.status(502).json({ error: 'star_failed', message: error?.message || String(error) });
  }
});

// ===== KERO-PONTE-PARIDADE-31-10-20261105-v1: rotas restauradas da ponte de 31/10 =====
app.get('/crm/media/raw', secure, async (req, res) => {
  const raw = mediaRaw.get(String(req.query.id || '')) || lerMidiaDisco(String(req.query.id || ''));
  if (!raw) return res.status(404).json({ ok: false, error: 'midia nao esta na memoria da ponte' });
  try {
    const m = raw.message || {};
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
    const tipo = Object.keys(inner).find(k => /(image|video|audio|document|sticker)Message$/.test(k));
    const buf = await downloadMediaMessage(raw, 'buffer', {}, { reuploadRequest: sock?.updateMediaMessage, logger: pino({ level: 'silent' }) });
    res.set('Content-Type', inner[tipo]?.mimetype || 'application/octet-stream');
    res.send(buf);
  } catch (e) { res.status(502).json({ ok: false, error: String(e?.message || e).slice(0, 160) }); }
});

app.post('/crm/send-pix', secure, async (req, res) => {
  if (process.env.KERO_PIX_LIBERADO !== '1') return res.status(423).json({ ok: false, error: 'ceo_pause_until_further_order', pulado: 'ceo-pause-pix', resume_requires: 'explicit_ceo_order' });
  try {
    res.json(await sendCrmPix(String(req.body?.jid || ''), req.body || {}));
  } catch (error) {
    console.error('[crm] send-pix failed', { message: error?.message || String(error) });
    res.status(error?.message === 'whatsapp_not_connected' ? 409 : 502).json({ error: error?.message || 'whatsapp_send_failed' });
  }
});

// CEO 26/10/2026: salvar contato na agenda do numero da Kero ("Motoboy Fabricio", "Cliente Joao - Empresa").
// GET devolve o nome salvo (name) e o do perfil (notify); POST salva/edita (sincroniza com o celular principal).
function contatoDe(jid) {
  const v = String(jid || '').replace(/:\d+@/, '@');
  const pn = v.endsWith('@lid') ? CRM.state.lidMap?.[v] : v;
  const lid = v.endsWith('@lid') ? v : Object.entries(CRM.state.lidMap || {}).find(([, p]) => p === v)?.[0];
  const c = { ...(lid ? CRM.state.contacts?.[lid] : {}), ...(pn ? CRM.state.contacts?.[pn] : {}) };
  return { pn: pn && pn.endsWith('@s.whatsapp.net') ? pn : null, lid: lid || null, name: c.name || null, notify: c.notify || c.verifiedName || null };
}
app.get('/crm/contact', secure, (req, res) => res.json(contatoDe(req.query.jid)));
app.post('/crm/save-contact', secure, async (req, res) => {
  const nome = String(req.body?.nome || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!req.body?.jid || !nome) return res.status(400).json({ error: 'jid_and_nome_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    let { pn, lid } = contatoDe(req.body.jid);
    if (!pn) { const r = await resolveOutboundJid(String(req.body.jid)); if (String(r).endsWith('@s.whatsapp.net')) pn = r; }
    if (!pn) return res.status(422).json({ error: 'sem_numero', message: 'nao achei o numero desse contato (so LID)' });
    if (typeof sock.addOrEditContact !== 'function') return res.status(501).json({ error: 'sem_suporte' });
    await sock.addOrEditContact(pn, { fullName: nome, firstName: nome.split(' ')[0], saveOnPrimaryAddressbook: true, ...(lid ? { lidJid: lid } : {}) });
    CRM.upsertContact({ id: pn, name: nome });
    if (lid) CRM.upsertContact({ id: lid, name: nome });
    res.json({ ok: true, pn, nome });
  } catch (error) {
    res.status(502).json({ error: 'save_contact_failed', message: error?.message || String(error) });
  }
});

// CEO 09/11/2026: arquivar conversa PRIVADA depois de um envio (ex.: disparo Dunelli). Grupos nunca.
app.post('/crm/archive', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid || /@g\.us$/.test(jid)) return res.status(400).json({ error: 'jid_privado_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    // CEO 09/11: quem acabou de enviar informa o id da propria mensagem (o historico local pode nao ter a conversa)
    const idDado = /^[A-Za-z0-9_-]{8,128}$/.test(String(req.body?.id || '')) ? String(req.body.id) : null;
    const tsDado = Number(req.body?.timestamp) > 1e9 ? Math.floor(Number(req.body.timestamp)) : Math.floor(Date.now() / 1000);
    const ult = idDado ? { id: idDado, fromMe: true, timestamp: tsDado }
      : ([targetJid, jid].flatMap(j => CRM.getMessages(j, { limit: 5 }).messages || []).sort((a, b) => Number(b.timestamp) - Number(a.timestamp)))[0];
    if (!ult) return res.status(422).json({ error: 'sem_mensagem', message: 'conversa sem mensagem salva' });
    const archive = req.body?.archive !== false;
    await sock.chatModify({ archive, lastMessages: [{ key: { remoteJid: targetJid, id: ult.id, fromMe: !!ult.fromMe }, messageTimestamp: Number(ult.timestamp) }] }, targetJid);
    res.json({ ok: true, archived: archive });
  } catch (error) {
    res.status(502).json({ error: 'archive_failed', message: error?.message || String(error) });
  }
});

// CEO 23/10/2026: a IA poe/tira uma conversa de uma etiqueta so quando a equipe manda (Agendado, Devedores sanados).
// Faturados, Grupos com clientes e etiquetas dos grupos de motoboy nunca sao tocadas por aqui.
const LABEL_PROTEGIDA = /faturad|grupos? com clientes?|grupos? 1[,.]50|grupos? 2[,.]00|encaixes? acima|carros? ?& ?utilit|min\.? ?20/i;
app.post('/crm/labels/chat', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const labelId = String(req.body?.labelId || '');
  const acao = req.body?.acao === 'remove' ? 'remove' : req.body?.acao === 'add' ? 'add' : '';
  if (!jid || !labelId || !acao) return res.status(400).json({ error: 'jid_labelId_acao_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  const nome = (CRM.snapshot({ limit: 0, includeMeta: true }).labels || []).find(l => String(l.id) === labelId)?.name || '';
  if (!nome) return res.status(404).json({ error: 'label_not_found' });
  // CEO 25/10/2026: a IA pode trocar as Listas de GRUPOS de motoboy (1,50 / 2,00 / Min 20$ / Encaixe / Carros) quando a regra
  // do grupo mudou (regraGrupo:true). Faturados e Grupos com clientes continuam protegidas sempre.
  const listaDeMotoboy = /grupos? 1[,.]50|grupos? 2[,.]00|encaixes? acima|carros? ?& ?utilit|min\.? ?20/i.test(nome);
  if (LABEL_PROTEGIDA.test(nome) && !(listaDeMotoboy && req.body?.regraGrupo === true && /@g\.us$/.test(jid))) return res.status(403).json({ error: 'label_protegida', name: nome });
  try {
    await sock.chatModify(acao === 'add' ? { addChatLabel: { labelId } } : { removeChatLabel: { labelId } }, jid);
    res.json({ ok: true, acao, label: nome });
  } catch (error) {
    res.status(502).json({ error: 'label_failed', message: error?.message || String(error) });
  }
});

app.post('/crm/resync', secure, async (_req, res) => {
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  const collections = ['critical_unblock_low','regular_high','regular_low','critical_block','regular'];
  await sock.resyncAppState(collections, true);
  const groups = await CRM.syncGroups(sock).catch(() => 0);
  const lids = await resolveStoredLids().catch(() => 0);
  CRM.saveNow();
  res.json({ ok: true, groups, lids });
});

app.get('/crm/ai/status', secure, (req, res) => {
  const jid = String(req.query.jid || '') || null;
  res.json(AI.status(jid));
});

app.post('/crm/ai/mode', secure, (req, res) => {
  const mode = String(req.body?.mode || '');
  const jid = String(req.body?.jid || '') || null;
  try {
    res.json({ ok: true, ...AI.setMode(mode, jid) });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'invalid_ai_mode' });
  }
});

app.get('/crm/ai/suggestions', secure, (req, res) => {
  const jid = String(req.query.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  res.json({ jid, suggestions: AI.listSuggestions(jid, limit) });
});

app.post('/crm/ai/suggestions/review', secure, (req, res) => {
  const jid = String(req.body?.jid || '');
  const id = String(req.body?.id || '');
  const nextStatus = String(req.body?.status || '');
  if (!jid || !id) return res.status(400).json({ error: 'jid_and_id_required' });
  try {
    res.json({ ok: true, suggestion: AI.reviewSuggestion(jid, id, nextStatus) });
  } catch (error) {
    const code = error?.message === 'suggestion_not_found' ? 404 : 400;
    res.status(code).json({ error: error?.message || 'suggestion_review_failed' });
  }
});

app.get('/crm/ai/audit', secure, (req, res) => {
  const jid = String(req.query.jid || '') || null;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  res.json({ jid, audit: AI.listAudit(jid, limit) });
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


// KERO_MAINTENANCE_V1
const TEMP_LABEL_NAMES = new Set(['📌Cliente do dia', '📌 Cliente do dia', 'Pagamento de Motoboy/Motorista']);
const CLIENT_GROUP_LABEL_NAME = 'Grupos com clientes';
const PROFESSIONAL_LABEL_NAMES = new Set(['Grupos 1,50 km','Grupos 2,00 km','Carros & Utilitarios','Carros & Utilitários','Encaixe acima de 70km','Min 20$ até 6km']);
const CLIENT_GROUP_PATTERNS = [
  /dunelli/i,/harmonia/i,/lm\s*melo/i,/resgatando\s*vidas/i,/time\s*atendimento/i,
  /grupo\s*de\s*o\.?\s*s\.?/i,/protocolos?\s*malotes?\s*larcon/i,/larcon/i,
  /diagn[oó]stica/i,/cientifica|cient[ií]fica/i,/dcbm/i,/data\s*center\s*brasil/i,
  /construtora\s*metrocasa/i,/bella\s*fit/i,/estante\s*m[aá]gica/i,
  /igrejas?.*vener/i,/vener[aá]vel/i,/semana\s*light/i,/chocolate\s*sp/i
];
const PROFESSIONAL_GROUP_PATTERNS = [
  /motoboy/i,/motofrete/i,/motofretista/i,/moto\s*frete/i,/motorista/i,/portador/i,
  /viagens?/i,/encaixe/i,/localiza[cç][aã]o/i,/s[oó]\s*rotas/i,/brasil\s*transportes/i,
  /brasil\s*express/i,/conex[aã]o\s*motoboy/i,/equipe\s*r1/i,/parceria\s*motofretistas/i,
  /uni[aã]o\s*dos\s*motoboys/i
];
const maintenanceFile = DATA_DIR + '/../kero-maintenance-state.json';
let maintenanceState = { lastDate: null, lastRun: null, lastResult: null };
try { if (fs.existsSync(maintenanceFile)) maintenanceState = { ...maintenanceState, ...JSON.parse(fs.readFileSync(maintenanceFile,'utf8')) }; } catch {}
const saveMaintenance = () => { try { fs.writeFileSync(maintenanceFile, JSON.stringify(maintenanceState, null, 2)); } catch {} };
const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
const labelsByName = () => new Map(Object.values(CRM.state.labels || {}).filter(x=>!x.deleted).map(x=>[norm(x.name).toLowerCase(), String(x.id)]));
const isClientGroup = g => CLIENT_GROUP_PATTERNS.some(rx => rx.test(String(g?.subject || '')));
const isProfessionalGroup = g => {
  if (!g?.id?.endsWith('@g.us') || isClientGroup(g)) return false;
  const byId = new Map(Object.values(CRM.state.labels || {}).filter(x=>!x.deleted).map(x=>[String(x.id), norm(x.name)]));
  const names = (CRM.state.chatLabels[g.id] || []).map(id=>byId.get(String(id))).filter(Boolean);
  if (names.some(n=>PROFESSIONAL_LABEL_NAMES.has(n))) return true;
  return PROFESSIONAL_GROUP_PATTERNS.some(rx=>rx.test(String(g.subject || '')));
};
async function ensureClientGroupLabel(dryRun=false) {
  const byName=labelsByName(); let id=byName.get(CLIENT_GROUP_LABEL_NAME.toLowerCase());
  if (!id) {
    const nums=Object.keys(CRM.state.labels||{}).map(Number).filter(Number.isFinite);
    id=String((nums.length?Math.max(...nums):40)+1);
    if (!dryRun) {
      await sock.chatModify({ addLabel:{ id, name:CLIENT_GROUP_LABEL_NAME, color:1, deleted:false } }, '');
      CRM.state.labels[id]={id,name:CLIENT_GROUP_LABEL_NAME,color:1,deleted:false}; CRM.saveNow();
    }
  }
  const targets=Object.values(CRM.state.groups||{}).filter(isClientGroup);
  const applied=[];
  for(const g of targets){
    if (!(CRM.state.chatLabels[g.id]||[]).map(String).includes(String(id))) {
      if(!dryRun) {
        await sock.chatModify({ addChatLabel:{ labelId:String(id) } }, g.id);
        CRM.state.chatLabels[g.id]=[...new Set([...(CRM.state.chatLabels[g.id]||[]).map(String),String(id)])];
      }
      applied.push({id:g.id,name:g.subject});
      if(!dryRun) await sleep(180);
    }
  }
  if(!dryRun) CRM.saveNow();
  return {labelId:id,targets:targets.map(g=>({id:g.id,name:g.subject})),applied};
}
async function removeTemporaryLabels(dryRun=false){
  const byName=labelsByName(); const ids=[...TEMP_LABEL_NAMES].map(n=>byName.get(norm(n).toLowerCase())).filter(Boolean);
  const removed=[];
  for(const [jid,labs] of Object.entries(CRM.state.chatLabels||{})){
    for(const id of ids){
      if((labs||[]).map(String).includes(String(id))){
        if(!dryRun) await sock.chatModify({ removeChatLabel:{labelId:String(id)} }, jid);
        removed.push({jid,labelId:id});
        if(!dryRun){ CRM.state.chatLabels[jid]=(CRM.state.chatLabels[jid]||[]).map(String).filter(x=>x!==String(id)); await sleep(120); }
      }
    }
  }
  if(!dryRun) CRM.saveNow();
  return removed;
}
// CEO 16/10/2026: clear ONLY the messages of archived groups; never delete/leave groups.
const isArchivedGroup = g => !!g?.id?.endsWith('@g.us') && CRM.state.chats?.[g.id]?.archived === true;
// KERO-LIMPEZA-ARQUIVADOS-20261109 (CEO 09/11): igual ao app "Limpar conversas" — limpa a conversa INTEIRA de cada grupo arquivado.
// Antes: so limpava mensagens guardadas aqui, mas o store apaga as mensagens de conversa arquivada -> limpava 0 todo dia.
// CEO 09/11 15h40: SO grupo de motoboy, motorista e localizacao (isProfessionalGroup: etiquetas 1,50/2,00/Min20/Carros/Encaixe ou nome).
// Grupo com cliente NUNCA. Nunca tambem: Time Atendimento, SuperGrupo/Apoio, Reuniao de ADMs, Ensinamentos, etiqueta 'Grupos com
// clientes' e grupo com disparo nosso nos ultimos 30 min. Nunca desarquiva, sai ou apaga grupo.
const LIMPEZA_PROTEGIDOS = /time atendimento|supergrupo|apoio|reuniao de adms|ensinamentos/i;
const temEtiquetaDeCliente = g => {
  const byId = new Map(Object.values(CRM.state.labels || {}).filter(x=>!x.deleted).map(x=>[String(x.id), norm(x.name)]));
  return (CRM.state.chatLabels?.[g.id] || []).map(id=>byId.get(String(id))).filter(Boolean).some(n=>/grupos? com clientes?/i.test(n));
};
function motivoParaNaoLimpar(g, agora=Date.now()){
  if(LIMPEZA_PROTEGIDOS.test(norm(g?.subject))) return 'protegido';
  if(temEtiquetaDeCliente(g)) return 'etiqueta_grupos_com_clientes';
  if(!isProfessionalGroup(g)) return 'nao_e_grupo_de_motoboy';
  if((CRM.state.keroSent?.[g.id] || []).some(m=>!m.deleted && agora - Number(m.timestamp)*1000 < 30*60e3)) return 'disparo_recente';
  return null;
}
async function clearArchivedGroups(dryRun=false){
  const results=[];
  for(const g of Object.values(CRM.state.groups||{})){
    if(!isArchivedGroup(g)) continue;
    const pulo=motivoParaNaoLimpar(g);
    if(pulo){results.push({id:g.id,name:g.subject,cleared:0,skipped:pulo});continue;}
    if(!dryRun){
      try { await sock.chatModify({ clear:true }, g.id); }
      catch(error){ results.push({id:g.id,name:g.subject,cleared:0,error:String(error?.message||error).slice(0,80)}); continue; }
      await sleep(400);
    }
    results.push({id:g.id,name:g.subject,cleared:1});
  }
  return results;
}
async function runKeroMaintenance({dryRun=false}={}){
  // Opt-in only: never clear messages or mutate labels by accident.
  if (!dryRun && process.env.CRM_ALLOW_DESTRUCTIVE_MAINTENANCE !== '1') throw new Error('destructive_maintenance_disabled');
  if(!sock || status!=='open') throw new Error('whatsapp_not_connected');
  // CEO midnight scope is limited to two temporary labels and archived-group message history.
  // Permanent client-group labeling remains a separate administrative action.
  const clientLabel={skipped:true,reason:'not_part_of_midnight_policy'};
  const tempLabels=await removeTemporaryLabels(dryRun);
  const groups=await clearArchivedGroups(dryRun);
  const result={dryRun,at:new Date().toISOString(),clientLabel,tempLabelsRemoved:tempLabels.length,archivedGroups:groups,totalMessages:groups.reduce((n,x)=>n+x.cleared,0)};
  if(!dryRun){maintenanceState.lastRun=result.at;maintenanceState.lastResult=result;saveMaintenance();}
  return result;
}
app.get('/crm/maintenance/status', secure, (_req,res)=>res.json({ok:true,state:maintenanceState}));
app.post('/crm/maintenance/run', secure, async (req,res)=>{
  try { res.json({ok:true,result:await runKeroMaintenance({dryRun:!!req.body?.dryRun})}); }
  catch(error){ res.status(500).json({error:'maintenance_failed',message:error?.message||String(error)}); }
});
setInterval(async ()=>{
  try{
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const date=parts.year+'-'+parts.month+'-'+parts.day;
    if(process.env.CRM_ALLOW_DESTRUCTIVE_MAINTENANCE === '1' && process.env.CRM_NIGHTLY_MAINTENANCE === '1' && parts.hour==='00' && Number(parts.minute)<10 && maintenanceState.lastDate!==date && status==='open'){
      const result=await runKeroMaintenance({dryRun:false});
      maintenanceState.lastDate=date;maintenanceState.lastResult=result;saveMaintenance();
      console.log('[maintenance] midnight completed', {date,temp:result.tempLabelsRemoved,groups:result.archivedGroups.length,messages:result.totalMessages});
    }
  }catch(error){console.error('[maintenance] midnight failed',error?.message||error);}
},60000);

// KERO 17/10/2026: fila brain.whatsapp_outbox — avisos enviados pelo servidor, sem navegador aberto.
// Opt-in: WA_OUTBOX_ENABLED=1 + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + WA_OUTBOX_ALLOWED_JIDS (lista separada por vírgula).
// KERO 18/10/2026: KERO_QUEUE_URL + KERO_QUEUE_TOKEN trocam a fila para o Cloudflare (sem eles, segue Supabase).
const outboxOnCloudflare = !!(process.env.KERO_QUEUE_URL && process.env.KERO_QUEUE_TOKEN);
const OUTBOX_TYPING = '__kero_digitando__';
if (process.env.WA_OUTBOX_ENABLED === '1' && (outboxOnCloudflare || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY))) {
  const outbox = createOutboxWorker({
    supabaseUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    queueUrl: outboxOnCloudflare ? process.env.KERO_QUEUE_URL : '',
    queueToken: process.env.KERO_QUEUE_TOKEN,
    allowedJids: parseAllowedJids(process.env.WA_OUTBOX_ALLOWED_JIDS),
    isReady: () => !!sock && status === 'open',
    // Mesma lógica da rota POST /crm/send.
    send: async (jid, text) => {
      if (!sock || status !== 'open') throw new Error('whatsapp_not_connected');
      const targetJid = await resolveOutboundJid(jid);
      if (jid.endsWith('@lid') && targetJid === jid) throw new Error('contact_number_still_syncing');
      // KERO 21/10/2026: linha especial da fila = mostrar "digitando..." enquanto o atendente prepara a resposta.
      if (text === OUTBOX_TYPING) {
        await sock.sendPresenceUpdate('composing', targetJid);
        return { messageId: 'presence:composing' };
      }
      const sent = await sock.sendMessage(targetJid, { text });
      if (sent) { marcarOrigem(sent); CRM.upsertMessage(sent); }
      await sock.sendPresenceUpdate('paused', targetJid).catch(() => null);
      return { messageId: sent?.key?.id || null };
    }
  });
  setInterval(() => { outbox.tick().then(r => { if (r.claimed) console.log('[outbox] tick', r); }); }, Number(process.env.WA_OUTBOX_INTERVAL_MS || 20000));
  console.log('[outbox] worker enabled', outboxOnCloudflare ? '(cloudflare)' : '(supabase)');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kero WhatsApp Bridge listening on ${PORT}`);
  setTimeout(() => {
    startSession('resume').catch(error => {
      console.error('[wa] automatic resume failed', error?.message || error);
    });
  }, 1000);
});
