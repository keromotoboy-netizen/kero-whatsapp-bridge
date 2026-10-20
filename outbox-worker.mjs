// KERO 17/10/2026: worker da fila brain.whatsapp_outbox (Supabase).
// Envia avisos sem depender de navegador aberto. Desligado por padrão (WA_OUTBOX_ENABLED=1 liga).
// Agentes só inserem linhas na fila; este worker reivindica (wa_outbox_claim), envia e conclui (wa_outbox_complete).

export function parseAllowedJids(value) {
  return new Set(String(value || '').split(',').map(s => s.trim()).filter(Boolean));
}

export function createOutboxWorker({
  supabaseUrl,
  serviceKey,
  queueUrl,
  queueToken,
  send,
  isReady,
  allowedJids,
  fetchImpl = globalThis.fetch,
  workerName = 'kero-whatsapp-bridge',
  batchSize = 5,
  logger = console
}) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const qbase = String(queueUrl || '').replace(/\/+$/, '');
  let running = false;

  // KERO 18/10/2026: com queueUrl, a fila fica no Cloudflare (Worker kero-nervoso-api + D1), mesma semântica das RPCs.
  async function queue(name, body) {
    const path = name === 'wa_outbox_claim' ? '/wa/claim' : '/wa/complete';
    const payload = name === 'wa_outbox_claim'
      ? { limit: body.p_limit, worker: body.p_worker }
      : { id: body.p_id, message_id: body.p_message_id, error: body.p_error };
    const res = await fetchImpl(`${qbase}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${queueToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`outbox_queue_${name}_http_${res.status}`);
    const data = (await res.json()).data;
    return name === 'wa_outbox_claim' ? (data || []) : data;
  }

  async function rpc(name, body) {
    if (qbase) return queue(name, body);
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`outbox_rpc_${name}_http_${res.status}`);
    return res.json();
  }

  async function tick() {
    if (running || !isReady()) return { skipped: true };
    running = true;
    const result = { claimed: 0, sent: 0, failed: 0 };
    try {
      const rows = await rpc('wa_outbox_claim', { p_limit: batchSize, p_worker: workerName });
      result.claimed = rows.length;
      for (const row of rows) {
        let messageId = null;
        let error = null;
        if (!allowedJids.has(row.jid)) {
          error = 'jid_not_allowed';
        } else {
          try {
            messageId = (await send(row.jid, row.text))?.messageId || null;
          } catch (e) {
            error = e?.message || 'whatsapp_send_failed';
          }
        }
        await rpc('wa_outbox_complete', { p_id: row.id, p_message_id: messageId, p_error: error });
        if (error) result.failed++; else result.sent++;
      }
    } catch (e) {
      logger.error('[outbox] tick failed', e?.message || String(e));
      result.error = e?.message || String(e);
    } finally {
      running = false;
    }
    return result;
  }

  return { tick };
}
