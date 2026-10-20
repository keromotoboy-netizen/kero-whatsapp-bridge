import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createD1Mirror } from '../d1-mirror.mjs';
import { createCrmStore } from '../crm-store.mjs';

const fakeFetch = (calls, status = 200) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: status === 200, status };
};
const quiet = { error: () => {} };
const setup = (opts = {}) => {
  const calls = [];
  const mirror = createD1Mirror({ queueUrl: 'https://x.test/', queueToken: 't', fetchImpl: opts.fetchImpl || fakeFetch(calls, opts.status), logger: quiet, ...opts.mirror });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-d1-mirror-'));
  fs.mkdirSync(path.join(root, 'auth'));
  const store = createCrmStore(path.join(root, 'auth'), { mirror });
  return { calls, mirror, store };
};
const msg = (id, jid, ts, text = 'oi', fromMe = false) => ({ key: { id, remoteJid: jid, fromMe }, messageTimestamp: ts, message: { conversation: text } });
const nowS = () => Math.floor(Date.now() / 1000);

test('mensagem nova vai ao D1 com a conversa, sem miniatura', async () => {
  const { calls, store, mirror } = setup();
  const jid = '5511900000001@s.whatsapp.net';
  store.upsertMessage({ key: { id: 'i1', remoteJid: jid, fromMe: false }, messageTimestamp: nowS(),
    message: { imageMessage: { mimetype: 'image/jpeg', jpegThumbnail: Buffer.from('x') } } });
  const r = await mirror.flush();
  assert.equal(r.sent, 2);
  assert.equal(calls[0].url, 'https://x.test/crm/ingest');
  assert.equal(calls[0].body.messages[0].id, 'i1');
  assert.equal(calls[0].body.messages[0].media.thumbnail, undefined);
  assert.equal(calls[0].body.chats[0].jid, jid);
  assert.equal(calls[0].body.chats[0].unread, 1);
  assert.equal(mirror.pending(), 0);
});

test('historico antigo nao vai ao D1; arquivada nao envia mensagem', async () => {
  const { calls, store, mirror } = setup();
  store.upsertMessage(msg('old', '5511900000002@s.whatsapp.net', 1000), { countUnread: false });
  store.upsertChat({ id: '5511900000003@s.whatsapp.net', archived: true });
  store.upsertMessage(msg('a1', '5511900000003@s.whatsapp.net', nowS()));
  await mirror.flush();
  assert.equal(calls[0].body.messages.length, 0);
  assert.equal(calls[0].body.chats.length, 2);
  assert.equal(calls[0].body.chats.find(c => c.archived).jid, '5511900000003@s.whatsapp.net');
});

test('falha do Cloudflare mantem no buffer e reenvia depois', async () => {
  let fail = true; const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return fail ? { ok: false, status: 500 } : { ok: true, status: 200 }; };
  const { store, mirror } = setup({ fetchImpl });
  store.upsertMessage(msg('f1', '5511900000004@s.whatsapp.net', nowS()));
  assert.ok((await mirror.flush()).error);
  assert.equal(mirror.pending(), 2);
  fail = false;
  assert.equal((await mirror.flush()).sent, 2);
  assert.equal(mirror.pending(), 0);
});

test('apagada vai como deleted; teto diario segura envio', async () => {
  const { calls, store, mirror } = setup({ mirror: { dailyCap: 1 } });
  const jid = '5511900000005@s.whatsapp.net';
  store.upsertMessage(msg('d1', jid, nowS()));
  await mirror.flush();
  store.markDeleted?.({ keys: [{ remoteJid: jid, id: 'd1' }] });
  mirror.remove(jid, 'd1');
  assert.equal((await mirror.flush()).capped, true);
  assert.equal(calls.length, 1);
});

test('mensagem de LID mapeado vai ao D1 com o numero (jid canonico)', async () => {
  const { calls, store, mirror } = setup();
  const lid = '123456789@lid', pn = '5511900000006@s.whatsapp.net';
  store.upsertLidMapping({ lid, pn });
  store.upsertMessage(msg('l1', lid, nowS()));
  await mirror.flush();
  const body = calls.at(-1).body;
  assert.equal(body.messages[0].jid, pn);
  assert.ok(body.chats.every(c => c.jid === pn));
});
