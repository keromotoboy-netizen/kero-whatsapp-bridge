// KERO-SG-FAVORITOS-POR-MENSAGEM-20261104-v1
// No send/delete; one star operation for each existing own group message.
export function mountCrmGroupStar(app, secure, { getSocket, isConnected, crm }) {
  function inspect(req, res) {
    const jid = String(req.body?.jid || '');
    const id = String(req.body?.id || '');
    if (!/^[0-9-]{10,60}@g\.us$/.test(jid) || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      res.status(400).json({ ok: false, error: 'invalid_group_message_key' });
      return null;
    }
    // Never star arbitrary, incoming, private, deleted or unsent messages.
    const msg = (crm?.state?.messages?.[jid] || []).find(m => m?.id === id && m?.fromMe === true);
    if (!msg) {
      res.status(404).json({ ok: false, error: 'own_message_not_in_local_history', noAction: true });
      return null;
    }
    return { jid, id, msg };
  }
  function status(key) {
    return { ok: true, operation: 'star', starred: key.msg.starred === true,
      confirmed: key.msg.starred === true, requested: !!key.msg.starRequestedAt };
  }
  app.post('/crm/star-status', secure, async (req, res) => {
    const key = inspect(req, res);
    if (key) res.json(status(key));
  });
  app.post('/crm/star', secure, async (req, res) => {
    const key = inspect(req, res);
    if (!key) return;
    if (key.msg.deleted) return res.status(409).json({ ok: false, error: 'message_already_deleted' });
    if (key.msg.starred === true) return res.json({ ...status(key), duplicateSuppressed: true });
    if (key.msg.starRequestedAt) return res.status(202).json({ ...status(key), duplicateSuppressed: true });
    if (!isConnected() || !getSocket()) return res.status(409).json({ ok: false, error: 'whatsapp_not_connected' });
    // Durable reservation before external mutation. Never retry on uncertain timeout.
    key.msg.starRequestedAt = Date.now();
    try { await crm.saveNow(true); }
    catch {
      delete key.msg.starRequestedAt;
      return res.status(503).json({ ok: false, error: 'durable_reservation_failed' });
    }
    try {
      await getSocket().chatModify({ star: { messages: [{ id: key.id, fromMe: true }], star: true } }, key.jid);
      key.msg.starred = true;
      key.msg.starAppliedAt = Date.now();
      await crm.saveNow(true);
      return res.json({ ...status(key), confirmation: 'baileys_chatModify_resolved' });
    } catch {
      return res.status(502).json({ ok: false, operation: 'star', error: 'star_outcome_unconfirmed',
        requested: true, starred: key.msg.starred === true, confirmed: false });
    }
  });
}
