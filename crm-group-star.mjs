// KERO-SG-FAVORITOS-POR-MENSAGEM-20261104-v2 (PR30 corrigido 09/11/2026)
// Rotas PROPRIAS (/crm/group/star, /crm/group/star-status): nao sobrepoem a /crm/star antiga (B0).
// Usa o indice duravel crm.ops (vale para grupo arquivado e depois da poda) (B1/M3/N1).
// Nada de envio/apagar aqui; nunca repete o comando depois de resultado incerto.
export function mountCrmGroupStar(app, secure, { getSocket, isConnected, crm }) {
  const inFlight = new Set();
  const ref = key => key.jid + '\u0000' + key.id;
  function inspect(req, res) {
    const jid = String(req.body?.jid || '');
    const id = String(req.body?.id || '');
    if (!/^[0-9-]{10,60}@g\.us$/.test(jid) || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      res.status(400).json({ ok: false, error: 'invalid_group_message_key' });
      return null;
    }
    // So mensagem PROPRIA ja registrada no indice (nunca de terceiros, privada ou inventada).
    const msg = crm?.ops?.get(jid, id);
    if (!msg || msg.fromMe !== true) {
      res.status(404).json({ ok: false, error: 'own_message_not_in_local_index', noAction: true });
      return null;
    }
    return { jid, id, msg };
  }
  function status(key) {
    const m = key.msg;
    // So o evento do WhatsApp, ja gravado em disco, prova a estrela.
    const confirmed = m.starred === true && !!m.starObservedAt && crm.ops.isDurable(m.starObservedAt);
    const observedNotDurable = m.starred === true && !!m.starObservedAt && !confirmed;
    const requested = !!m.starRequestedAt;
    const outcome = confirmed ? 'CONFIRMED'
      : observedNotDurable ? 'UNKNOWN'
      : m.starOutcomeUnknownAt ? 'UNKNOWN'
      : inFlight.has(ref(key)) ? 'IN_FLIGHT'
      : m.starCommandAckAt ? 'PENDING'
      : requested ? 'UNKNOWN' : 'NOT_REQUESTED';
    return { ok: true, operation: 'star', messageRef: { jid: key.jid, id: key.id }, requested,
      accepted: !!m.starCommandAckAt, starred: confirmed, confirmed, outcome,
      confirmationSource: confirmed ? 'messages.update:starred' : null };
  }
  app.post('/crm/group/star-status', secure, (req, res) => {
    const key = inspect(req, res);
    if (key) res.json(status(key));
  });
  app.post('/crm/group/star', secure, async (req, res) => {
    const key = inspect(req, res);
    if (!key) return;
    const m = key.msg;
    if (m.deleted || m.deletedForEveryone === true) return res.status(409).json({ ok: false, error: 'message_already_deleted', noAction: true });
    if (m.deleteRequestedAt) return res.status(409).json({ ok: false, error: 'message_delete_already_requested', noAction: true });
    const atual = status(key);
    if (atual.confirmed) return res.json({ ...atual, duplicateSuppressed: true });
    if (m.starRequestedAt || m.starObservedAt) return res.status(202).json({ ...atual, duplicateSuppressed: true });
    if (!isConnected() || !getSocket()) return res.status(409).json({ ok: false, error: 'whatsapp_not_connected' });
    // Reserva duravel (arquivo pequeno) antes do efeito externo.
    m.starRequestedAt = Date.now();
    try { crm.ops.saveStrict(); }
    catch {
      delete m.starRequestedAt;
      return res.status(503).json({ ok: false, error: 'durable_reservation_failed', noAction: true });
    }
    inFlight.add(ref(key));
    try {
      await getSocket().chatModify({ star: { messages: [{ id: key.id, fromMe: true }], star: true } }, key.jid);
      m.starCommandAckAt = Date.now();
      try { crm.ops.saveStrict(); } catch {}
      inFlight.delete(ref(key));
      const st = status(key);
      return res.status(st.confirmed ? 200 : 202).json({ ...st, confirmation: 'baileys_command_accepted_not_star_proof' });
    } catch {
      m.starOutcomeUnknownAt = Date.now();
      try { crm.ops.saveStrict(); } catch {}
      inFlight.delete(ref(key));
      return res.status(502).json({ ...status(key), ok: false, error: 'star_outcome_unconfirmed' });
    }
  });
}
