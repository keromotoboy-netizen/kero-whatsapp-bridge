// KERO PR30 (09/11/2026): indice duravel e pequeno das mensagens PROPRIAS em grupos + reservas de envio.
// Arquivo proprio (crm-own-ops.json), independente de arquivamento e da poda de state.messages,
// para favoritar/apagar/recibo idempotente funcionarem em grupo arquivado e depois de poda.
// Gravacao estrita so deste arquivo (pequeno e limitado), nunca do estado inteiro da CRM.
import nodeFs from 'node:fs';
import path from 'node:path';

const MSG_TTL_MS = 62 * 3600 * 1000;           // WhatsApp so apaga para todos ate ~60 h
const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;    // operacao pendente/incerta fica ate 7 dias
const MAX_PER_GROUP = 300;
const MAX_RESERVATIONS = 5000;
const RESERVATION_TTL_MS = 7 * 24 * 3600 * 1000;

const pendente = r => !!(r && (r.starRequestedAt || r.deleteRequestedAt) &&
  !(r.starred === true && r.starObservedAt) && !(r.deletedForEveryone === true && r.deleteConfirmedAt));

export function createOwnOps(dataDir, { fs = nodeFs, now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'crm-own-ops.json');
  let state = { msgs: {}, reservations: {} };
  // Tudo o que foi gravado com sucesso ate este instante e duravel (inclusive o que veio do disco).
  let durableAt = 0;
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { msgs: parsed.msgs || {}, reservations: parsed.reservations || {} };
      durableAt = now();
    }
  } catch (error) {
    console.error('[crm-ops] failed to load', error?.code || 'parse_error');
  }

  const prune = () => {
    const t = now();
    for (const [jid, map] of Object.entries(state.msgs)) {
      const vivos = Object.entries(map).filter(([, r]) =>
        (t - Number(r.createdAt || 0)) < MSG_TTL_MS || (pendente(r) && (t - Number(r.createdAt || 0)) < PENDING_TTL_MS));
      vivos.sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
      // Limite por grupo: corta os mais antigos que nao estao pendentes.
      let excesso = vivos.length - MAX_PER_GROUP;
      const ficam = vivos.filter(([, r]) => !(excesso > 0 && !pendente(r) && excesso-- > 0));
      if (ficam.length) state.msgs[jid] = Object.fromEntries(ficam); else delete state.msgs[jid];
    }
    const res = Object.entries(state.reservations)
      .filter(([, r]) => (t - Number(r.createdAt || 0)) < RESERVATION_TTL_MS)
      .sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
    state.reservations = Object.fromEntries(res.slice(-MAX_RESERVATIONS));
  };

  // Escrita estrita: lanca erro se o disco falhar. So este arquivo pequeno.
  const saveStrict = () => {
    const marca = now();
    prune();
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    fs.renameSync(file + '.tmp', file);
    durableAt = Math.max(durableAt, marca);
  };
  const isDurable = ts => !!ts && ts <= durableAt;

  const get = (jid, id) => state.msgs[jid]?.[id] || null;
  const record = (jid, id, { participant = null, timestamp = null } = {}) => {
    if (!String(jid).endsWith('@g.us') || !id) return null;
    const map = state.msgs[jid] ||= {};
    const atual = map[id];
    if (atual) return atual;
    map[id] = { id, fromMe: true, createdAt: now(), timestamp: timestamp == null ? null : Number(timestamp), ...(participant ? { participant } : {}) };
    return map[id];
  };

  // Eventos do WhatsApp (estrela / apagar para todos). Devolve true se mudou algo.
  const observeStar = (jid, id, starred) => {
    const r = get(jid, id);
    if (!r) return false;
    if (starred) {
      if (r.starred === true && r.starObservedAt) return false;
      r.starred = true; r.starObservedAt = now();
    } else {
      if (r.starred !== true && !r.starRequestedAt && !r.starObservedAt) return false;
      // Desfavoritado: limpa o ciclo inteiro para permitir favoritar de novo (M6).
      r.starred = false;
      for (const k of ['starObservedAt', 'starRequestedAt', 'starCommandAckAt', 'starOutcomeUnknownAt']) delete r[k];
    }
    return true;
  };
  const observeRevoke = (jid, id) => {
    const r = get(jid, id);
    if (!r || (r.deletedForEveryone === true && r.deleteConfirmedAt)) return false;
    r.deleted = true; r.deletedForEveryone = true; r.deleteConfirmedAt = now();
    return true;
  };

  const reservation = key => state.reservations[key] || null;
  const reserve = (key, data) => { state.reservations[key] = { ...data, createdAt: now() }; return state.reservations[key]; };
  const updateReservation = (key, data) => { if (state.reservations[key]) Object.assign(state.reservations[key], data); return state.reservations[key] || null; };
  const dropReservation = key => { delete state.reservations[key]; };

  return { file, state: () => state, get, record, observeStar, observeRevoke, reservation, reserve, updateReservation, dropReservation, saveStrict, isDurable, prune };
}
