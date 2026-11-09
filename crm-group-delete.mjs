// KERO P0 — apagar PARA TODOS uma mensagem propria de grupo (PR30 corrigido 09/11/2026).
// Rotas PROPRIAS (/crm/group/delete, /crm/group/delete-status): nao sobrepoem a /crm/delete antiga (B0).
// Usa o indice duravel crm.ops (grupo arquivado / depois da poda). Nunca repete depois de incerteza.
const DELETE_WINDOW_MS = 60 * 3600 * 1000; // WhatsApp so apaga para todos ate ~60 h (M8)

export function mountCrmGroupDelete(app, secure, { getSocket, isConnected, crm, now = () => Date.now() }) {
  const inFlight = new Set();
  const ref = key => key.jid + '\u0000' + key.id;
  function inspect(req, res) {
    const jid = String(req.body?.jid || '');
    const id = String(req.body?.id || '');
    if (!/^[0-9-]{10,60}@g\.us$/.test(jid) || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      res.status(400).json({ ok: false, error: 'invalid_group_message_key' });
      return null;
    }
    const msg = crm?.ops?.get(jid, id);
    if (!msg || msg.fromMe !== true) {
      res.status(404).json({ ok: false, error: 'own_message_not_in_local_index', noAction: true });
      return null;
    }
    return { jid, id, msg };
  }
  function status(key) {
    const m = key.msg;
    const confirmed = m.deletedForEveryone === true && !!m.deleteConfirmedAt && crm.ops.isDurable(m.deleteConfirmedAt);
    const observedNotDurable = m.deletedForEveryone === true && !!m.deleteConfirmedAt && !confirmed;
    const requested = !!m.deleteRequestedAt;
    const outcome = confirmed ? 'CONFIRMED'
      : observedNotDurable ? 'UNKNOWN'
      : m.deleteOutcomeUnknownAt ? 'UNKNOWN'
      : inFlight.has(ref(key)) ? 'IN_FLIGHT'
      : m.deleteCommandAckAt ? 'PENDING'
      : requested ? 'UNKNOWN' : 'NOT_REQUESTED';
    return { ok: true, operation: 'delete', messageRef: { jid: key.jid, id: key.id }, requested,
      accepted: !!m.deleteCommandAckAt, confirmed, deleted: confirmed, outcome,
      confirmationSource: confirmed ? 'messages.update:REVOKE' : null };
  }
  app.post('/crm/group/delete-status', secure, (req, res) => {
    const key = inspect(req, res);
    if (key) res.json(status(key));
  });
  app.post('/crm/group/delete', secure, async (req, res) => {
    const key = inspect(req, res);
    if (!key) return;
    const m = key.msg;
    if (m.deletedForEveryone === true) {
      const st = status(key);
      return res.status(st.confirmed ? 200 : 202).json({ ...st, duplicateSuppressed: true });
    }
    if (m.deleteRequestedAt) return res.status(202).json({ ...status(key), duplicateSuppressed: true });
    const enviadaEm = Number(m.timestamp) > 0 ? Number(m.timestamp) * 1000 : Number(m.createdAt || 0);
    if (!enviadaEm || now() - enviadaEm > DELETE_WINDOW_MS) {
      return res.status(409).json({ ok: false, error: 'message_too_old_to_delete_for_everyone', noAction: true });
    }
    const sock = getSocket();
    if (!isConnected() || !sock) return res.status(409).json({ ok: false, error: 'whatsapp_not_connected' });
    m.deleteRequestedAt = Date.now();
    try { crm.ops.saveStrict(); }
    catch {
      delete m.deleteRequestedAt;
      return res.status(503).json({ ok: false, error: 'durable_reservation_failed', noAction: true });
    }
    inFlight.add(ref(key));
    try {
      const originalKey = { remoteJid: key.jid, id: key.id, fromMe: true };
      if (m.participant) originalKey.participant = m.participant;
      await sock.sendMessage(key.jid, { delete: originalKey });
      m.deleteCommandAckAt = Date.now();
      try { crm.ops.saveStrict(); } catch {}
      inFlight.delete(ref(key));
      const st = status(key);
      return res.status(st.confirmed ? 200 : 202).json(st);
    } catch {
      m.deleteOutcomeUnknownAt = Date.now();
      try { crm.ops.saveStrict(); } catch {}
      inFlight.delete(ref(key));
      return res.status(502).json({ ...status(key), ok: false, error: 'delete_outcome_unconfirmed' });
    }
  });
}
