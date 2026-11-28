// CEO 28/10/2026: o libsignal imprimia no log do Railway as sessoes de criptografia (chaves) a cada troca de sessao.
// Nada de sessao/chave no log: so a linha curta do aviso.
for (const nivel of ['info', 'warn']) {
  const orig = console[nivel].bind(console);
  console[nivel] = (...a) => { const t = String(a[0] ?? ''); if (/^(Closing|Opening|Removing|Migrating)( open| old closed)? ?session/i.test(t)) return; /* KERO 28/11: sem a linha de sessao (era ruido) */ return /session|prekey|Bad MAC/i.test(t) ? orig(t.slice(0, 80)) : orig(...a); };
}
import express from 'express';
import makeWASocket, {
  downloadMediaMessage,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  extractSyncdPatches, decodeSyncdSnapshot, decodePatches, decodeSyncdMutations, proto,
  generateWAMessageFromContent, BufferJSON
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
import { mountArchivedGroupCleanup } from './archived-group-cleanup.mjs';
import { createCrmArchivedCleanup } from './archived-cleanup-service.mjs';
import { readSavedState } from './archive-state-reader.mjs';

const LID_VISTOS = new Set();
const LID_PEND = new Set(); let lidTimer = null; // KERO 28/11: lid novo resolvido na hora (antes so ao reconectar)
const REENVIO_LOG = new Set(); // KERO 28/11: loga cada mensagem apagada so 1 vez
const app = express();
app.use(express.json({ limit: '24mb' }));

const PORT = Number(process.env.PORT || 3000);
const API_SECRET = process.env.API_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || './data/auth';
// reenvio de mensagem que o outro lado nao conseguiu abrir (getMessage) + contador de tentativas do Baileys
const ENVIADAS = new Map();
// CEO 30/10: O.S apagada nao pode voltar: se um aparelho pedir reenvio de uma mensagem ja apagada, a ponte nao reenvia.
const APAGADAS = new Set();
const RETRY = new Map();
const RETRY_CACHE = { get: k => RETRY.get(k), set: (k, v) => { RETRY.set(k, v); if (RETRY.size > 5000) RETRY.delete(RETRY.keys().next().value); return true; }, del: k => RETRY.delete(k), flushAll: () => RETRY.clear() };

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
const CRM = createCrmStore(DATA_DIR, { mirror: d1Mirror, onMedia: lembrarMidia });
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
const archivedGroupCleanup=createCrmArchivedCleanup({
  getConnection:()=>status==='open'?sock:null,
  readState:()=>CRM.state,
  sdk:{extractSyncdPatches,decodeSyncdSnapshot,decodePatches,decodeSyncdMutations,proto}
});
mountArchivedGroupCleanup(app,secure,archivedGroupCleanup);

// CEO 31/10/2026: a ponte nao conseguia ler etiquetas, nomes salvos e arquivadas (faltava a chave do app-state:
// "failed to find key"). Pede a chave ao celular (mensagem interna do proprio WhatsApp, so para o nosso aparelho) e rele tudo.
const SDK_APP = { extractSyncdPatches, decodeSyncdSnapshot, decodePatches, decodeSyncdMutations, proto };
const COLECOES = ['regular', 'regular_high', 'regular_low', 'critical_block', 'critical_unblock_low'];
let chavesUlt = null;
async function consertarChaves(extra = []) {
  if (!sock || status !== 'open') return { erro: 'WHATSAPP_NOT_CONNECTED' };
  const antes = await readSavedState(sock, SDK_APP).catch(e => ({ errors: { leitura: String(e?.message || e).slice(0, 80) } }));
  const ids = new Set(extra.map(String));
  for (const e of Object.values(antes.errors || {})) { const m = String(e).match(/key "([^"]+)"/); if (m) ids.add(m[1]); }
  let pedido = false;
  if (ids.size) {
    const me = String(sock.authState?.creds?.me?.id || '').replace(/:\d+@/, '@');
    await sock.relayMessage(me, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
      appStateSyncKeyRequest: { keyIds: [...ids].map(id => ({ keyId: Buffer.from(id, 'base64') })) } } },
      { additionalAttributes: { category: 'peer', push_priority: 'high_force' } });
    pedido = true;
    await new Promise(r => setTimeout(r, 20000)); // o celular responde com a chave em segundos
  }
  let resync = 'ok';
  if (ids.size || Object.keys(antes.errors || {}).length) { try { await sock.resyncAppState(COLECOES, false); } catch (e) { resync = String(e?.message || e).slice(0, 120); } }
  const depois = await readSavedState(sock, SDK_APP).catch(e => ({ errors: { leitura: String(e?.message || e).slice(0, 80) } }));
  // a leitura completa e a verdade: refaz as etiquetas das conversas quando ela vier sem erro
  if (!Object.keys(depois.errors || {}).length && Array.isArray(depois.membros)) {
    const novo = {}; for (const m of depois.membros) { const j = String(m.jid).replace(/:\d+@/, '@'); (novo[j] ||= []).includes(m.labelId) || novo[j].push(m.labelId); }
    CRM.state.chatLabels = novo;
    for (const l of depois.listas || []) CRM.state.labels[l.id] = { ...(CRM.state.labels[l.id] || {}), id: l.id, name: l.name, color: l.color, deleted: false };
    try { CRM.saveNow(); } catch {}
  }
  chavesUlt = { at: new Date().toISOString(), pedidas: [...ids], pedido, resync, errosAntes: antes.errors, errosDepois: depois.errors, membros: depois.membros?.length || 0 };
  console.log('[app-state] conserto', JSON.stringify(chavesUlt).slice(0, 400));
  return chavesUlt;
}
app.post('/crm/app-state/fix-keys', secure, async (req, res) => {
  try { res.json(await consertarChaves(req.body?.keyIds || [])); } catch (e) { res.status(500).json({ error: 'FIX_KEYS_FAILED', message: String(e?.message || e).slice(0, 160) }); }
});
app.get('/crm/app-state/fix-keys', secure, (_req, res) => res.json(chavesUlt || {}));
// sozinho: 3 min depois de ligar e depois a cada hora, enquanto faltar chave
setTimeout(() => consertarChaves().catch(() => null), 180e3);
setInterval(() => { if (!chavesUlt || Object.keys(chavesUlt.errosDepois || {}).length) consertarChaves().catch(() => null); }, 3600e3);

// Somente leitura: respostas rapidas salvas + mensagens favoritas (estrela), com o texto quando a ponte o tem.
app.get('/crm/app-state/saved', secure, async (_req,res)=>{
  if(!sock || status!=='open') return res.status(412).json({error:'WHATSAPP_NOT_CONNECTED'});
  try{
    const r=await readSavedState(sock,{extractSyncdPatches,decodeSyncdSnapshot,decodePatches,decodeSyncdMutations,proto});
    const starred=r.starred.map(s=>{
      const m=(CRM.getMessages(s.jid,{limit:5000}).messages||[]).find(x=>x.id===s.id);
      return {...s,chat:CRM.state.groups?.[s.jid]?.subject||CRM.state.contacts?.[s.jid]?.name||CRM.state.chats?.[s.jid]?.name||'',text:m?.text||null,messageTimestamp:m?.timestamp||null};
    });
    res.json({ok:true,quickReplies:r.quickReplies,starred,errors:r.errors,tipos:r.tipos,listas:r.listas,membros:r.membros});
  }catch(error){ res.status(500).json({error:'APP_STATE_READ_FAILED',message:String(error?.message||error).slice(0,160)}); }
});

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

setInterval(() => resolveStoredLids().then(n => { if (n) console.log('[crm] lid resync=' + n); }).catch(() => {}), 20 * 60 * 1000); // KERO 28/11: antes so no startup

async function resolveOutboundJid(jid) {
  const value = String(jid || '');
  const stored = CRM.resolveSendJid(value);
  if (!value.endsWith('@lid') || stored !== value) return stored;

  const mappings = await sock?.signalRepository?.lidMapping?.getPNsForLIDs?.([value]).catch(() => null);
  for (const mapping of mappings || []) CRM.upsertLidMapping(mapping);

  return CRM.resolveSendJid(value);
}

async function sendCrmText(jid, text, quotedId) {
  const value = String(jid || '');
  const message = String(text || '').trim();
  if (!value || !message) throw new Error('jid_and_text_required');
  if (!sock || status !== 'open') throw new Error('whatsapp_not_connected');

  const targetJid = await resolveOutboundJid(value);
  if (value.endsWith('@lid') && targetJid === value) {
    throw new Error('contact_number_still_syncing');
  }

  // 23/10: responder marcando uma mensagem (quotedId = id da mensagem do cliente)
  let quoted;
  if (quotedId) {
    const q = [value, targetJid].flatMap(j => CRM.getMessages(j, { limit: 300 }).messages || []).find(x => x.id === quotedId);
    if (q) quoted = { key: { remoteJid: targetJid, id: q.id, fromMe: !!q.fromMe, participant: q.participant || undefined }, message: { conversation: String(q.text || '') } };
  }
  const sent = await sock.sendMessage(targetJid, { text: message }, quoted ? { quoted } : undefined);
  if (sent) CRM.upsertMessage(sent);
  return { ok: true, messageId: sent?.key?.id || null, resolved: targetJid !== value };
}

// CEO 25/10/2026: cartao nativo "Chave Pix" (igual ao do WhatsApp Business: banco, nome, chave e botao "Copiar chave Pix").
// Valor opcional (em reais). Sem cobranca automatica: o cliente copia a chave e paga no banco dele.
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
  CRM.upsertMessage({ key: msg.key, message: { conversation: `[Chave Pix] ${nome} ${tipo}: ${chave}` }, messageTimestamp: Math.floor(Date.now() / 1000) });
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
      // CEO 25/10/2026: nunca se identificar como CRM/IA/robo: aparece como um Chrome no Windows comum
      // (tambem e o formato que o WhatsApp aceita para conectar por codigo de numero)
      browser: ['Windows', 'Chrome', '10.0.22631'],
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      // CEO 28/10: "Bad MAC"/mensagem que nao abriu -> o WhatsApp pede para reenviar; sem isto a ponte nao conseguia
      // reenviar e o cliente ficava com "Aguardando mensagem". Guarda as mensagens enviadas e conta as tentativas.
      msgRetryCounterCache: RETRY_CACHE,
      getMessage: async key => APAGADAS.has(key?.id) ? (REENVIO_LOG.has(key?.id) ? 0 : (REENVIO_LOG.add(key?.id), console.log('[crm] reenvio negado: mensagem apagada', key?.id)), undefined) : ENVIADAS.get(key?.id) || mediaRaw.get(key?.id)?.message || undefined
    });
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages || []) if (m.key?.fromMe && m.key.id && m.message) {
        ENVIADAS.set(m.key.id, m.message);
        if (ENVIADAS.size > 3000) ENVIADAS.delete(ENVIADAS.keys().next().value);
      }
    });

    CRM.attach(sock);
    // KERO 28/11 (CEO): resposta de cliente chega por chat oculto (@lid) e a ponte nao ligava ao numero. O Baileys 7 traz o numero nas chaves
    // (remoteJidAlt / participantAlt) quando sabe; guarda esse mapa para o /crm/messages?jid=<numero> trazer as respostas.
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages || []) {
        try {
          const k = m.key || {};
          for (const [id, alt] of [[k.remoteJid, k.remoteJidAlt], [k.participant, k.participantAlt]]) {
            if (String(id || '').endsWith('@lid') && String(alt || '').endsWith('@s.whatsapp.net')) { CRM.upsertLidMapping({ lid: id, pn: alt }); LID_VISTOS.add(id); }
            else if (String(id || '').endsWith('@lid') && !CRM.state?.lidMap?.[id]) {
              LID_PEND.add(id); clearTimeout(lidTimer);
              lidTimer = setTimeout(async () => { const l = [...LID_PEND]; LID_PEND.clear(); try { for (const mp of (await sock?.signalRepository?.lidMapping?.getPNsForLIDs?.(l)) || []) CRM.upsertLidMapping(mp); } catch { /* tenta no proximo ciclo */ } }, 2500);
            }
          }
        } catch { /* nao derruba a ponte */ }
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // CEO 26/10: guarda a estrutura completa dos cartoes "Chave Pix" que o celular manda (resposta rapida do Business)
      // para a IA copiar o formato exato. So mensagens interativas enviadas pela Kero; nada de cliente.
      for (const m of messages || []) {
        const c = m.message || {};
        const inner = c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.ephemeralMessage?.message || c;
        if (m.key?.fromMe && (inner.interactiveMessage || inner.buttonsMessage || inner.templateMessage)) {
          try { fs.appendFileSync(DATA_DIR + '/cartoes-pix.jsonl', JSON.stringify({ em: new Date().toISOString(), type, key: m.key, message: c }) + '\n'); } catch {}
        }
      }
      if (type !== 'notify') return;
      for (const message of messages || []) {
        AI.handleIncoming(message).catch(error => {
          console.error('[ai] incoming handler failed', error?.message || error);
        });
        verificarPrimeiroContato(message).catch(() => {});
      }
    });
    // chats.update traz o timer da conversa (o mesmo do perfil da pessoa > Mensagens temporarias)
    sock.ev.on('chats.update', chats => {
      for (const c of chats || []) {
        if (c?.id && c.ephemeralExpiration !== undefined) TEMPORARIAS.timer.set(c.id, Number(c.ephemeralExpiration) || 0);
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
        if (typeof sock.updateDefaultDisappearingMode === 'function') sock.updateDefaultDisappearingMode(0).then(() => console.log('[temporarias] timer padrao da conta = desligado')).catch(e => console.error('[temporarias] timer padrao falhou', e?.message || e));
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

app.get('/crm/messages', secure, (req, res) => {
  const jid = String(req.query.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 120)));
  const before = Math.max(0, Number(req.query.before || 0));
  const offset = Math.max(0, Number(req.query.offset || 0));
  res.json({ jid, ...CRM.getMessages(jid, { limit, before, offset }) });
});

// KERO 28/11 (CEO): respostas NOVAS de todos os chats numa chamada so, com o chat oculto (@lid) ja ligado ao numero (pn). Para os robos (ex.: Dunelli).
app.get('/crm/inbox', secure, (req, res) => {
  const since = Math.max(0, Number(req.query.since || 0));
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 300)));
  const lm = CRM.state?.lidMap || {}, vistos = new Set(), out = [];
  for (const [jid, arr] of Object.entries(CRM.state?.messages || {})) {
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
    const pnRaw = jid.endsWith('@lid') ? lm[jid] : jid, pn = pnRaw && String(pnRaw).endsWith('@s.whatsapp.net') ? pnRaw : null;
    for (const m of arr || []) {
      if (!m || m.fromMe) continue;
      const ts = typeof m.timestamp === 'object' && m.timestamp ? Number(m.timestamp.low || 0) + Number(m.timestamp.high || 0) * 4294967296 : Number(m.timestamp) || 0;
      if (ts < since || vistos.has(m.id)) continue; vistos.add(m.id);
      out.push({ jid, pn, nome: CRM.state.chats?.[jid]?.name || m.pushName || null, id: m.id, timestamp: ts, type: m.type || null, text: m.text || null });
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ since, total: out.length, messages: out.slice(-limit) });
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
    res.json(await sendCrmText(jid, text, req.body?.quotedId ? String(req.body.quotedId) : undefined));
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

app.post('/crm/send-pix', secure, async (req, res) => {
  try {
    res.json(await sendCrmPix(String(req.body?.jid || ''), req.body || {}));
  } catch (error) {
    console.error('[crm] send-pix failed', { message: error?.message || String(error) });
    res.status(error?.message === 'whatsapp_not_connected' ? 409 : 502).json({ error: error?.message || 'whatsapp_send_failed' });
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

// CEO 25/10/2026: marcar como LIDA de verdade (tique azul no WhatsApp da pessoa) as mensagens recebidas ainda nao lidas
// da conversa, antes de responder, como uma pessoa faz. Antes so marcava no CRM local.
app.post('/crm/seen', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid) return res.status(400).json({ error: 'missing_jid' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const msgs = CRM.getMessages(jid, { limit: 15 }).messages || [];
    const ultimaNossa = Math.max(0, ...msgs.filter(m => m.fromMe).map(m => Number(m.timestamp) || 0));
    const keys = msgs.filter(m => !m.fromMe && m.id && (Number(m.timestamp) || 0) >= ultimaNossa)
      .map(m => ({ remoteJid: m.remoteJid || m.chatJid || m.jid || jid, id: m.id, fromMe: false, ...(m.participant ? { participant: m.participant } : {}) }));
    if (keys.length) await sock.readMessages(keys);
    CRM.markReadLocal(jid);
    res.json({ ok: true, lidas: keys.length });
  } catch (error) {
    res.status(502).json({ error: 'seen_failed', message: error?.message || String(error) });
  }
});

// CEO 25/10/2026: le a DESCRICAO do grupo (regras de valor dos grupos de motoboys mudam; a IA confere antes de disparar)
app.get('/crm/group-info', secure, async (req, res) => {
  const jid = String(req.query.jid || '');
  if (!/@g\.us$/.test(jid)) return res.status(400).json({ error: 'group_jid_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const m = await sock.groupMetadata(jid);
    // 26/10: participantes (LID + numero) com ?participantes=1 -> o atendente reconhece motoboy/motorista por grupo em comum
    const participantes = req.query.participantes ? (m?.participants || []).map(p => ({ id: p.id, lid: p.lid || (String(p.id).endsWith('@lid') ? p.id : null), numero: p.phoneNumber || p.jid || (String(p.id).endsWith('@s.whatsapp.net') ? p.id : null) })) : undefined;
    res.json({ ok: true, jid, subject: m?.subject || '', desc: m?.desc || '', descId: m?.descId || null, descTime: m?.descTime || null, participantes });
  } catch (error) {
    res.status(502).json({ error: 'group_info_failed', message: error?.message || String(error) });
  }
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

// CEO 24/10/2026: conversa com mensagens temporarias -> desliga sozinho e confere nos dois lugares
// (aviso na area de mensagens e timer do perfil da pessoa, que no WhatsApp e o mesmo ajuste da conversa).
// So UMA verificacao por conversa: no primeiro contato (nos chamamos ou a pessoa chama), a partir de 24/10/2026 ~19h40.
// Conversas anteriores ficam de fora (a equipe ja tratou). Lista das ja verificadas fica em disco.
const TEMPORARIAS_INICIO = 1792881600; // 2026-10-24T22:40:00Z
const TEMPORARIAS_ARQ = DATA_DIR.replace(/[\\/]+$/, '') + '-temporarias-verificadas.json';
const TEMPORARIAS = { timer: new Map(), ultimo: new Map(), log: [], vistas: new Set() };
try { for (const j of JSON.parse(fs.readFileSync(TEMPORARIAS_ARQ, 'utf8'))) TEMPORARIAS.vistas.add(j); } catch {}
const gravarVistas = () => { try { fs.writeFileSync(TEMPORARIAS_ARQ, JSON.stringify([...TEMPORARIAS.vistas])); } catch {} };
async function verificarPrimeiroContato(message) {
  const jid = message?.key?.remoteJid || '';
  if (!jid || /@(broadcast|newsletter)$|@g\.us$/.test(jid) || TEMPORARIAS.vistas.has(jid)) return;
  if (Number(message?.messageTimestamp || 0) < TEMPORARIAS_INICIO) return;
  const m = message?.message;
  if (!m || m.protocolMessage?.type === 0 || m.reactionMessage) return;
  // mensagem nossa nao mostra o timer; espera a primeira da pessoa, a nao ser que o timer ja seja conhecido
  const timer = TEMPORARIAS.timer.get(jid);
  if (message.key.fromMe && !temporariaAtiva(m) && !(timer > 0)) return;
  TEMPORARIAS.vistas.add(jid); gravarVistas();
  if (temporariaAtiva(m) || timer > 0) await desligarTemporarias(jid, message.key.fromMe ? 'primeiro_contato_nosso' : 'primeiro_contato_cliente');
}
function temporariaAtiva(m) {
  if (!m) return false;
  if (m.ephemeralMessage) return true;
  const p = m.protocolMessage;
  if (p && (p.type === 3 || p.type === 'EPHEMERAL_SETTING')) return Number(p.ephemeralExpiration) > 0;
  const inner = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
  return Object.values(inner).some(v => v && typeof v === 'object' && Number(v.contextInfo?.expiration) > 0);
}
async function desligarTemporarias(jid, origem) {
  if (!sock || status !== 'open' || /@(broadcast|newsletter)$/.test(jid)) return { ok: false, motivo: 'indisponivel' };
  const agora = Date.now();
  TEMPORARIAS.ultimo.set(jid, agora);
  const item = { at: new Date(agora).toISOString(), jid, origem, ok: false };
  try {
    await sock.sendMessage(await resolveOutboundJid(jid), { disappearingMessagesInChat: false });
    item.ok = true;
  } catch (error) {
    item.erro = error?.message || String(error);
  }
  TEMPORARIAS.log.push(item);
  if (TEMPORARIAS.log.length > 200) TEMPORARIAS.log.shift();
  console.log('[temporarias] ' + (item.ok ? 'desligadas' : 'falhou') + ' origem=' + origem);
  return item;
}
app.post('/crm/ephemeral', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid) return res.status(400).json({ error: 'jid_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  TEMPORARIAS.ultimo.delete(jid);
  res.json(await desligarTemporarias(jid, 'manual'));
});
app.get('/crm/ephemeral', secure, (_req, res) => {
  res.json({ ativas: [...TEMPORARIAS.timer].filter(([, t]) => t > 0).map(([jid, t]) => ({ jid, segundos: t })), log: TEMPORARIAS.log.slice(-50) });
});

// CEO 24/10/2026: ao recalcular, a IA apaga para todos o orcamento anterior (so mensagem enviada por nos).
app.post('/crm/delete', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const id = String(req.body?.id || '');
  if (!jid || !id) return res.status(400).json({ error: 'jid_and_id_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    APAGADAS.add(id); ENVIADAS.delete(id);
    await sock.sendMessage(targetJid, { delete: { remoteJid: targetJid, id, fromMe: true } });
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'delete_failed', message: error?.message || String(error) });
  }
});

// CEO 27/10/2026: favoritar a O.S jogada nos grupos (a alocacao chamava /crm/star, que nao existia -> nada era favoritado)
app.post('/crm/star', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  const id = String(req.body?.id || '');
  const star = req.body?.star !== false;
  if (!jid || !id) return res.status(400).json({ error: 'jid_and_id_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    await sock.chatModify({ star: { messages: [{ id, fromMe: true }], star } }, targetJid);
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: 'star_failed', message: error?.message || String(error) });
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

// CEO 25/10/2026: toda O.S que a IA joga nos grupos fica FAVORITADA (estrela): se a IA falhar em apagar,
// a equipe apaga para todos pela lista de Favoritos. star=false tira a estrela. So mensagem nossa (fromMe padrao true).
// KERO 07/11/2026: segunda rota /crm/star (codigo morto, o Express usa a primeira) removida; backup server.mjs.bak-20261107-star-duplicada
// CEO 06/11/2026: arquivar/desarquivar uma conversa PRIVADA (disparo Dunelli: manda e arquiva para nao poluir o atendimento).
// Nunca grupos. archive=false desarquiva. Precisa da ultima mensagem da conversa (o WhatsApp exige).
app.post('/crm/archive', secure, async (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid || /@g\.us$/.test(jid)) return res.status(400).json({ error: 'jid_privado_required' });
  if (!sock || status !== 'open') return res.status(409).json({ error: 'whatsapp_not_connected' });
  try {
    const targetJid = await resolveOutboundJid(jid);
    const ult = ([targetJid, jid].flatMap(j => CRM.getMessages(j, { limit: 5 }).messages || []).sort((a, b) => Number(b.timestamp) - Number(a.timestamp)))[0];
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
const TEMP_LABEL_NAMES = new Set(['📌Cliente do dia', '📌 Cliente do dia', 'Cliente do dia', 'Pagamento de Motoboy/Motorista'] /* CEO 31/10: a etiqueta real e 'Cliente do dia' sem alfinete */);
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
// 23/10/2026: limpa pelo horario de corte (como o archived-group-cleanup), sem depender das mensagens salvas
// nesta ponte: a reserva nao guarda o historico antigo e o formato antigo {clear:{messages}} nao existe no Baileys 7.
async function clearArchivedGroups(dryRun=false){
  const results=[];
  const cutoff=Math.floor(Date.now()/1000)-1;
  for(const g of Object.values(CRM.state.groups||{})){
    if(!isArchivedGroup(g)) continue;
    // CEO 27/10/2026: so grupos de motoboys/motoristas/interior. Nunca o Time de Atendimento da Kero, apoio ou ADMs.
    if(/atendimento|apoio|\badms?\b|reuni[aã]o|ensinament/i.test(String(g.subject||CRM.state.chats?.[g.id]?.name||''))){ results.push({id:g.id,name:g.subject,cleared:0,skipped:'excluido'}); continue; }
    const msgs=(CRM.getMessages(g.id,{limit:500}).messages||[]).filter(m=>!m.deleted);
    // Victoria disparando servico nesse grupo (mensagem nossa nas ultimas 2 h) -> nao limpa hoje
    if(CRM.osArquivadas().some(o=>o.jid===g.id && Date.now()/1000-Number(o.timestamp)<2*3600) || msgs.some(m=>m.fromMe && Date.now()/1000-Number(m.timestamp)<2*3600)){ results.push({id:g.id,name:g.subject,cleared:0,skipped:'disparo_recente'}); continue; }
    if(!dryRun){
      try{
        await sock.chatModify({ clear:true, lastMessages:{ lastMessageTimestamp:cutoff, lastSystemMessageTimestamp:cutoff } }, g.id);
      }catch(error){ results.push({id:g.id,name:g.subject,cleared:0,error:String(error?.message||error).slice(0,120)}); continue; }
      await sleep(1000);
    }
    results.push({id:g.id,name:g.subject,cleared:msgs.length});
  }
  return results;
}
// CEO 27/10/2026: limpa a conversa SO dos grupos indicados pelo atendente (motoboys/motoristas/interior), e so se o grupo
// estiver ARQUIVADO. Nunca desarquiva, apaga, sai do grupo nem escreve nada. Quem escolhe a lista e o atendente (exclui o Time de
// Atendimento e confere se a Victoria nao esta disparando).
app.post('/crm/archived-groups/clear/selected', secure, async (req,res)=>{
  try{
    if(req.body?.confirm!=='LIMPAR_SO_ARQUIVADOS' || !Array.isArray(req.body?.jids)) return res.status(400).json({error:'invalid_request'});
    if(!sock || status!=='open') return res.status(412).json({error:'whatsapp_not_connected'});
    const cutoff=Math.floor(Date.now()/1000)-1, out=[];
    for(const jid of req.body.jids.slice(0,200)){
      const g=CRM.state.groups?.[jid]||{id:jid};
      if(!String(jid).endsWith('@g.us') || !isArchivedGroup({...g,id:jid})){ out.push({jid,skipped:'nao_arquivado'}); continue; }
      try{ await sock.chatModify({ clear:true, lastMessages:{ lastMessageTimestamp:cutoff, lastSystemMessageTimestamp:cutoff } }, jid); out.push({jid,cleared:true}); }
      catch(error){ out.push({jid,error:String(error?.message||error).slice(0,120)}); }
      await sleep(800);
    }
    res.json({ok:true,cutoff,results:out});
  }catch(error){ res.status(500).json({error:'clear_failed',message:String(error?.message||error).slice(0,200)}); }
});
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
app.get('/crm/os-arquivadas', secure, (_req,res)=>res.json({ok:true,os:CRM.osArquivadas().map(o=>({...o,grupo:CRM.state.groups?.[o.jid]?.subject||''}))}));
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
      if (sent) CRM.upsertMessage(sent);
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
