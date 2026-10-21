import express from 'express';
import makeWASocket, {
  downloadMediaMessage,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import { createCrmStore } from './crm-store.mjs';
import { createOutboxWorker, parseAllowedJids } from './outbox-worker.mjs';
import { createD1Mirror } from './d1-mirror.mjs';
import { createMediaUploader } from './media-r2.mjs';
import { createAiEngine } from './ai-engine.mjs';
import { selectAuthDirectory } from './auth-directory.mjs';
import { maintenanceMutationAllowed, scheduledMaintenanceAllowed } from './maintenance-permissions.mjs';
import { createArchivedGroupCleanup, mountArchivedGroupCleanup } from './archived-group-cleanup.mjs';

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
const CRM = createCrmStore(DATA_DIR, { mirror: d1Mirror, onMedia: mediaR2 ? mediaR2.enqueue : null });
if (mediaR2) console.log('[media-r2] ligado');
if (d1Mirror) {
  setInterval(() => { d1Mirror.flush().catch(() => null); }, Number(process.env.CRM_D1_INTERVAL_MS || 5000));
  console.log('[d1-mirror] ligado');
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
const archivedGroupCleanup=createArchivedGroupCleanup({
  getConnection:()=>status==='open'?sock:null,
  readState:()=>CRM.state,
  refresh:async connection=>{
    await connection.resyncAppState(['regular_low','regular_high'],false);
    const groups=await connection.groupFetchAllParticipating();
    return new Set(Object.keys(groups||{}));
  }
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
  if (sent) CRM.upsertMessage(sent);
  return { ok: true, messageId: sent?.key?.id || null, resolved: targetJid !== value };
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
async function clearArchivedGroups(dryRun=false){
  const results=[];
  for(const g of Object.values(CRM.state.groups||{})){
    if(!isArchivedGroup(g)) continue;
    const msgs=(CRM.getMessages(g.id,{limit:500}).messages||[]).filter(m=>!m.deleted);
    if(!msgs.length){results.push({id:g.id,name:g.subject,cleared:0});continue;}
    if(!dryRun){
      const payload=msgs.map(m=>({id:m.id,fromMe:!!m.fromMe,timestamp:String(m.timestamp)}));
      await sock.chatModify({ clear:{messages:payload} }, g.id);
      await sleep(250);
    }
    results.push({id:g.id,name:g.subject,cleared:msgs.length});
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
      const sent = await sock.sendMessage(targetJid, { text });
      if (sent) CRM.upsertMessage(sent);
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
