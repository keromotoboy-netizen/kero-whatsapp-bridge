// KERO P0 — delete for EVERYONE, one existing own group message per request.
// Draft only: do not deploy before coordinating the attendant's deletion status contract.
// The Bridge does not interpret LLM commands and never resends a deletion after uncertainty.
export function mountCrmGroupDelete(app, secure, { getSocket, isConnected, crm }) {
  function inspect(req, res) {
    const jid = String(req.body?.jid || '');
    const id = String(req.body?.id || '');
    if (!/^[0-9-]{10,60}@g\.us$/.test(jid) || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      res.status(400).json({ ok: false, error: 'invalid_group_message_key' });
      return null;
    }
    const msg = (crm?.state?.messages?.[jid] || []).find(m => m?.id === id && m?.fromMe === true);
    if (!msg) {
      res.status(404).json({ ok: false, error: 'own_message_not_in_local_history', noAction: true });
      return null;
    }
    return { jid, id, msg };
  }
  function status(key) {
    // A Baileys sendMessage return is not a server-side revoke event.
    const confirmed = key.msg.deletedForEveryone === true &&
      !!key.msg.deleteConfirmedAt && key.msg.deleteReceiptDurable === true;
    const requested = !!key.msg.deleteRequestedAt;
    return {
      ok: true, operation: 'delete', requested,
      accepted: !!key.msg.deleteCommandAckAt,
      confirmed, deleted: confirmed,
      outcome: confirmed ? 'CONFIRMED' : key.msg.deleteOutcomeUnknownAt ? 'UNKNOWN' : requested ? 'PENDING' : 'NOT_REQUESTED',
      confirmationSource: confirmed ? 'messages.update:REVOKE' : null
    };
  }
  app.post('/crm/delete-status', secure, async (req, res) => {
    const key = inspect(req, res);
    if (key) res.json(status(key));
  });
  app.post('/crm/delete', secure, async (req, res) => {
    const key = inspect(req, res);
    if (!key) return;
    if (key.msg.deletedForEveryone === true) {
      const state = status(key);
      return res.status(state.confirmed ? 200 : 202).json({ ...state, duplicateSuppressed: true });
    }
    if (key.msg.deleted === true) {
      return res.status(409).json({ ok: false, error: 'message_deleted_without_for_everyone_ack', noAction: true });
    }
    if (key.msg.deleteRequestedAt) {
      return res.status(202).json({ ...status(key), duplicateSuppressed: true });
    }
    const sock = getSocket();
    if (!isConnected() || !sock) return res.status(409).json({ ok: false, error: 'whatsapp_not_connected' });
    key.msg.deleteRequestedAt = Date.now();
    try {
      await crm.saveNow(true);
    } catch {
      delete key.msg.deleteRequestedAt;
      return res.status(503).json({ ok: false, error: 'durable_reservation_failed' });
    }
    try {
      // Baileys official API: sendMessage(jid, {delete: original.key}).
      const originalKey = { remoteJid: key.jid, id: key.id, fromMe: true };
      if (key.msg.participant) originalKey.participant = key.msg.participant;
      await sock.sendMessage(key.jid, { delete: originalKey });
      key.msg.deleteCommandAckAt = Date.now();
      await crm.saveNow(true);
      const state = status(key);
      return res.status(state.confirmed ? 200 : 202).json(state);
    } catch {
      key.msg.deleteOutcomeUnknownAt = Date.now();
      try { await crm.saveNow(true); } catch {}
      return res.status(502).json({ ...status(key), ok: false, error: 'delete_outcome_unconfirmed' });
    }
  });
}
