import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaUploader, mediaKey, MEDIA_MAX_BYTES } from '../media-r2.mjs';
import { createCrmStore } from '../crm-store.mjs';

const quiet = { error: () => {} };
const wait = up => new Promise(r => { const t = setInterval(() => { if (up.idle()) { clearInterval(t); r(); } }, 5); });
const imgMsg = (id, jid, size = 1000, ts = Math.floor(Date.now() / 1000)) => ({ key: { id, remoteJid: jid, fromMe: false }, messageTimestamp: ts,
  message: { imageMessage: { mimetype: 'image/jpeg', fileLength: size } } });

test('mensagem nova com foto vai ao R2 e o D1 recebe a chave', async () => {
  const puts = [];
  const up = createMediaUploader({ queueUrl: 'https://x.test', queueToken: 't', logger: quiet,
    download: async () => Buffer.from('jpg'), fetchImpl: async (url, init) => { puts.push({ url, init }); return { ok: true, status: 200 }; } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-r2-'));
  fs.mkdirSync(path.join(root, 'auth'));
  const store = createCrmStore(path.join(root, 'auth'), { onMedia: up.enqueue });
  const jid = '5511900000007@s.whatsapp.net';
  store.upsertMessage(imgMsg('p1', jid));
  await wait(up);
  assert.equal(puts.length, 1);
  assert.match(puts[0].url, /\/crm\/media\?key=/);
  assert.equal(puts[0].init.headers['Content-Type'], 'image/jpeg');
  assert.equal(store.getMessages(jid, { limit: 5 }).messages[0].media.r2Key, mediaKey(jid, 'p1'));
});

test('historico, arquivo grande e fila cheia nao vao ao R2', async () => {
  let downloads = 0;
  const up = createMediaUploader({ queueUrl: 'https://x.test', queueToken: 't', logger: quiet, maxQueue: 0,
    download: async () => { downloads++; return Buffer.from('x'); }, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(up.enqueue(imgMsg('g1', 'a@s.whatsapp.net'), 'a@s.whatsapp.net', { size: MEDIA_MAX_BYTES + 1 }), null);
  assert.equal(up.enqueue(imgMsg('g2', 'a@s.whatsapp.net'), 'a@s.whatsapp.net', { size: 10 }), null); // fila cheia (maxQueue 0)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-r2-'));
  fs.mkdirSync(path.join(root, 'auth'));
  const calls = [];
  const store = createCrmStore(path.join(root, 'auth'), { onMedia: (...a) => { calls.push(a); return null; } });
  store.upsertMessage(imgMsg('h1', 'b@s.whatsapp.net'), { countUnread: false });
  assert.equal(calls.length, 0);
  assert.equal(downloads, 0);
});

test('teto do Worker pausa envios por 1 h e falha de download nao trava a fila', async () => {
  let now = 1e12, puts = 0;
  const up = createMediaUploader({ queueUrl: 'https://x.test', queueToken: 't', logger: quiet, clock: () => now,
    download: async raw => { if (raw.key.id === 'bad') throw new Error('expirada'); return Buffer.from('x'); },
    fetchImpl: async () => { puts++; return { ok: false, status: 429 }; } });
  up.enqueue(imgMsg('bad', 'c@s.whatsapp.net'), 'c@s.whatsapp.net', { size: 1 });
  up.enqueue(imgMsg('ok1', 'c@s.whatsapp.net'), 'c@s.whatsapp.net', { size: 1 });
  up.enqueue(imgMsg('ok2', 'c@s.whatsapp.net'), 'c@s.whatsapp.net', { size: 1 });
  await wait(up);
  assert.equal(puts, 1); // ok1 recebeu 429; ok2 nem tentou
  now += 3600001;
  up.enqueue(imgMsg('ok3', 'c@s.whatsapp.net'), 'c@s.whatsapp.net', { size: 1 });
  await wait(up);
  assert.equal(puts, 2);
});
