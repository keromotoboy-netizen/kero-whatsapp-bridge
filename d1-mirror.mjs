// KERO 20/10/2026 (CRM etapa 3): grava em dobro conversas e mensagens no D1 (Worker kero-nervoso-api /crm/ingest).
// Desligado por padrão (CRM_D1_MIRROR=1 liga). Falha no Cloudflare nunca afeta o WhatsApp: só fica no buffer e tenta depois.
const BATCH = 150;

export function createD1Mirror({
  queueUrl,
  queueToken,
  fetchImpl = globalThis.fetch,
  dailyCap = 40000,
  maxBuffer = 5000,
  logger = console,
  clock = () => Date.now()
}) {
  const base = String(queueUrl || '').replace(/\/+$/, '');
  const msgs = new Map(), chats = new Set(), deleted = new Map();
  let resolveChat = () => null, flushing = false, day = '', sentToday = 0, capLogged = false;

  const trim = map => { while (map.size > maxBuffer) map.delete(map.keys().next().value); };
  const message = item => {
    if (!item?.jid || !item?.id) return;
    const media = item.media ? { ...item.media } : null;
    if (media) delete media.thumbnail; // miniatura base64 não vai ao D1 (mídia fica para o R2, etapa 5)
    msgs.set(item.jid + '|' + item.id, {
      jid: item.jid, id: item.id, fromMe: !!item.fromMe, participant: item.participant || null, pushName: item.pushName || null,
      timestamp: item.timestamp, type: item.type || null, text: item.text || null, media, location: item.location || null
    });
    trim(msgs);
    chats.add(item.jid);
  };
  const chat = jid => { if (jid) chats.add(jid); };
  const remove = (jid, id) => { if (jid && id) { msgs.delete(jid + '|' + id); deleted.set(jid + '|' + id, { jid, id }); trim(deleted); } };

  async function flush() {
    if (flushing || !base || (!msgs.size && !chats.size && !deleted.size)) return { skipped: true };
    const today = new Date(clock()).toISOString().slice(0, 10);
    if (today !== day) { day = today; sentToday = 0; capLogged = false; }
    if (sentToday >= dailyCap) {
      if (!capLogged) { logger.error('[d1-mirror] teto diario atingido', dailyCap); capLogged = true; }
      return { capped: true };
    }
    flushing = true;
    const take = (src, n) => { const out = []; for (const [k, v] of src) { if (out.length >= n) break; out.push([k, v]); } return out; };
    const m = take(msgs, BATCH), d = take(deleted, BATCH);
    const c = [];
    for (const jid of chats) {
      if (c.length >= BATCH) break;
      const row = resolveChat(jid);
      if (row) c.push([jid, row]); else chats.delete(jid);
    }
    try {
      const res = await fetchImpl(`${base}/crm/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${queueToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chats: c.map(x => x[1]), messages: m.map(x => x[1]), deleted: d.map(x => x[1]) })
      });
      if (!res.ok) throw new Error('d1_mirror_http_' + res.status);
      // só remove do buffer o que foi enviado e não mudou de novo durante o envio
      for (const [k, v] of m) if (msgs.get(k) === v) msgs.delete(k);
      for (const [k] of d) deleted.delete(k);
      for (const [jid, row] of c) if (JSON.stringify(resolveChat(jid)) === JSON.stringify(row)) chats.delete(jid);
      sentToday += m.length + c.length + d.length;
      return { sent: m.length + c.length + d.length };
    } catch (e) {
      logger.error('[d1-mirror] envio falhou', e?.message || String(e));
      return { error: e?.message || String(e) };
    } finally {
      flushing = false;
    }
  }

  return { message, chat, remove, flush, bind: fn => { resolveChat = fn; }, pending: () => msgs.size + chats.size + deleted.size };
}
