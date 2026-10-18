import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxWorker, parseAllowedJids } from '../outbox-worker.mjs';

const VICTOR = '5511966316454@s.whatsapp.net';

function fakeSupabase(rows) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const name = url.split('/rpc/')[1];
    const body = JSON.parse(opts.body);
    calls.push({ name, body, auth: opts.headers.Authorization });
    const data = name === 'wa_outbox_claim' ? rows : {};
    return { ok: true, status: 200, json: async () => data };
  };
  return { calls, fetchImpl };
}

test('sends allowed rows and completes with messageId', async () => {
  const sb = fakeSupabase([{ id: 1, jid: VICTOR, text: 'oi' }]);
  const sent = [];
  const w = createOutboxWorker({
    supabaseUrl: 'https://x.supabase.co/', serviceKey: 'k', isReady: () => true,
    allowedJids: parseAllowedJids(VICTOR), fetchImpl: sb.fetchImpl,
    send: async (jid, text) => { sent.push([jid, text]); return { messageId: 'M1' }; }
  });
  const r = await w.tick();
  assert.deepEqual(r, { claimed: 1, sent: 1, failed: 0 });
  assert.deepEqual(sent, [[VICTOR, 'oi']]);
  assert.deepEqual(sb.calls[1], { name: 'wa_outbox_complete', body: { p_id: 1, p_message_id: 'M1', p_error: null }, auth: 'Bearer k' });
});

test('never sends to a jid outside the allowlist', async () => {
  const sb = fakeSupabase([{ id: 2, jid: '5511000000000@s.whatsapp.net', text: 'x' }]);
  let sends = 0;
  const w = createOutboxWorker({
    supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', isReady: () => true,
    allowedJids: parseAllowedJids(VICTOR), fetchImpl: sb.fetchImpl, send: async () => { sends++; }
  });
  const r = await w.tick();
  assert.equal(sends, 0);
  assert.equal(r.failed, 1);
  assert.equal(sb.calls[1].body.p_error, 'jid_not_allowed');
});

test('reports send errors back so the database decides retry', async () => {
  const sb = fakeSupabase([{ id: 3, jid: VICTOR, text: 'x' }]);
  const w = createOutboxWorker({
    supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', isReady: () => true,
    allowedJids: parseAllowedJids(VICTOR), fetchImpl: sb.fetchImpl,
    send: async () => { throw new Error('whatsapp_not_connected'); }, logger: { error() {} }
  });
  await w.tick();
  assert.equal(sb.calls[1].body.p_error, 'whatsapp_not_connected');
});

test('does not claim anything while WhatsApp is not connected', async () => {
  const sb = fakeSupabase([{ id: 4, jid: VICTOR, text: 'x' }]);
  const w = createOutboxWorker({
    supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', isReady: () => false,
    allowedJids: parseAllowedJids(VICTOR), fetchImpl: sb.fetchImpl, send: async () => ({})
  });
  assert.deepEqual(await w.tick(), { skipped: true });
  assert.equal(sb.calls.length, 0);
});
