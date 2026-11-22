// PR30 corrigido (09/11/2026): favoritar/apagar/recibo de grupo pelo indice duravel crm-own-ops.
// Offline: sem WhatsApp, sem Railway; socket falso e pasta temporaria.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Script, createContext } from 'node:vm';
import { createOwnOps } from '../crm-own-ops.mjs';
import { mountCrmGroupStar } from '../crm-group-star.mjs';
import { mountCrmGroupDelete } from '../crm-group-delete.mjs';

const A = '1234567890-123456789@g.us', B = '1234567890-123456790@g.us';
const ID = '3EB0AAAA12345678';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kero-pr30-'));

// fs falso que pode falhar a escrita sob comando
function flakyFs() {
  const f = { fail: false, writes: 0 };
  return Object.assign(f, {
    existsSync: p => fs.existsSync(p), readFileSync: (p, e) => fs.readFileSync(p, e),
    writeFileSync: (p, d) => { if (f.fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); f.writes++; fs.writeFileSync(p, d); },
    renameSync: (a, b) => fs.renameSync(a, b)
  });
}

function routes(crm, { connected = true, sock } = {}) {
  const map = new Map();
  const app = { post: (p, _auth, cb) => map.set(p, cb) };
  mountCrmGroupStar(app, () => {}, { getSocket: () => sock, isConnected: () => connected, crm });
  mountCrmGroupDelete(app, () => {}, { getSocket: () => sock, isConnected: () => connected, crm });
  const req = async (p, body) => { let code = 200, data; const res = { status(n) { code = n; return this; }, json(x) { data = x; return this; } }; await map.get(p)({ body }, res); return { code, data }; };
  return { map, req };
}
function fakeSock({ failStar = false, failDelete = false } = {}) {
  const calls = [];
  return { calls,
    chatModify: async (...a) => { calls.push(['star', ...a]); if (failStar) throw new Error('timed out'); },
    sendMessage: async (...a) => { calls.push(['send', ...a]); if (failDelete) throw new Error('timed out'); return { key: { id: 'REVOKE1234567', remoteJid: a[0], fromMe: true } }; } };
}

// ---------- B0: rotas proprias, sem sobrepor as antigas ----------
test('B0: modulos novos so registram /crm/group/*; /crm/star e /crm/delete antigas ficam livres', () => {
  const ops = createOwnOps(tmp());
  const { map } = routes({ ops });
  assert.deepEqual([...map.keys()].sort(), ['/crm/group/delete', '/crm/group/delete-status', '/crm/group/star', '/crm/group/star-status']);
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /app\.post\('\/crm\/star'/);
  assert.match(server, /app\.post\('\/crm\/delete'/);
});

// ---------- B1 / N1 / M3: grupo arquivado e poda ----------
async function storeFixture() {
  const src = fs.readFileSync(new URL('../crm-store.mjs', import.meta.url), 'utf8')
    .replace("import { WAMessageStubType } from 'baileys';", 'const WAMessageStubType = { REVOKE: 68 };')
    .replace("from './crm-own-ops.mjs'", "from '" + pathToFileURL(path.resolve('crm-own-ops.mjs')).href + "'");
  const { createCrmStore } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const dir = tmp();
  const store = createCrmStore(dir);
  const ev = new EventEmitter();
  store.attach({ ev });
  return { dir, store, ev, createCrmStore };
}
const raw = (jid, id, ts = Math.floor(Date.now() / 1000)) => ({ key: { remoteJid: jid, id, fromMe: true }, messageTimestamp: ts, message: { conversation: 'O.S sintetica' } });

test('B1: mensagem propria em grupo ARQUIVADO entra no indice e pode ser favoritada e confirmada', async () => {
  const t = await storeFixture();
  t.store.upsertChat({ id: A, archived: true });
  t.store.upsertMessage(raw(A, ID));
  assert.equal((t.store.state.messages[A] || []).length, 0, 'arquivado continua fora de state.messages');
  assert.ok(t.store.ops.get(A, ID), 'mas esta no indice proprio');
  const sock = fakeSock();
  const r = routes(t.store, { sock });
  const s = await r.req('/crm/group/star', { jid: A, id: ID });
  assert.equal(s.code, 202); assert.equal(s.data.outcome, 'PENDING');
  t.ev.emit('messages.update', [{ key: { remoteJid: A, id: ID }, update: { starred: true } }]);
  assert.equal((await r.req('/crm/group/star-status', { jid: A, id: ID })).data.outcome, 'CONFIRMED');
});

test('N1/M3: arquivar e podar depois da reserva nao apaga a trilha da operacao (sobrevive a reinicio)', async () => {
  const t = await storeFixture();
  t.store.upsertMessage(raw(A, ID));
  const sock = fakeSock();
  await routes(t.store, { sock }).req('/crm/group/delete', { jid: A, id: ID });
  t.store.upsertChat({ id: A, archived: true });
  delete t.store.state.messages[A];
  t.store.saveNow();
  const reaberto = t.createCrmStore(t.dir);
  const r2 = routes(reaberto, { sock });
  const d = await r2.req('/crm/group/delete', { jid: A, id: ID });
  assert.equal(d.code, 202); assert.equal(d.data.duplicateSuppressed, true);
  assert.equal(sock.calls.length, 1, 'nunca apaga duas vezes');
});

// ---------- M5: durabilidade se recupera ----------
test('M5: evento observado com disco falhando fica UNKNOWN e vira CONFIRMED na proxima gravacao boa', () => {
  const ffs = flakyFs();
  const ops = createOwnOps(tmp(), { fs: ffs });
  ops.record(A, ID, { timestamp: Math.floor(Date.now() / 1000) });
  ops.saveStrict();
  const r = routes({ ops });
  ops.state().msgs[A][ID].starRequestedAt = Date.now();
  ffs.fail = true;
  ops.observeStar(A, ID, true);
  assert.throws(() => ops.saveStrict());
  const key = { jid: A, id: ID };
  return r.req('/crm/group/star-status', key).then(async s1 => {
    assert.equal(s1.data.outcome, 'UNKNOWN');
    ffs.fail = false; ops.saveStrict();
    assert.equal((await r.req('/crm/group/star-status', key)).data.outcome, 'CONFIRMED');
  });
});

// ---------- M6: desfavoritar e favoritar de novo ----------
test('M6: depois de desfavoritar, pode favoritar de novo (um comando por ciclo)', async () => {
  const ops = createOwnOps(tmp());
  ops.record(A, ID, { timestamp: Math.floor(Date.now() / 1000) });
  const sock = fakeSock();
  const r = routes({ ops }, { sock });
  await r.req('/crm/group/star', { jid: A, id: ID });
  ops.observeStar(A, ID, true); ops.saveStrict();
  ops.observeStar(A, ID, false); ops.saveStrict();
  const s = await r.req('/crm/group/star', { jid: A, id: ID });
  assert.equal(s.code, 202); assert.equal(sock.calls.length, 2);
});

// ---------- M8 / seguranca do apagar ----------
test('M8: mensagem com mais de 60 h nao tenta apagar para todos', async () => {
  const ops = createOwnOps(tmp());
  ops.record(A, ID, { timestamp: Math.floor(Date.now() / 1000) - 61 * 3600 });
  const sock = fakeSock();
  const d = await routes({ ops }, { sock }).req('/crm/group/delete', { jid: A, id: ID });
  assert.equal(d.code, 409); assert.equal(d.data.noAction, true); assert.equal(sock.calls.length, 0);
});

test('falha de disco antes do efeito bloqueia favoritar e apagar (zero chamadas)', async () => {
  const ffs = flakyFs();
  const ops = createOwnOps(tmp(), { fs: ffs });
  ops.record(A, ID, { timestamp: Math.floor(Date.now() / 1000) });
  ffs.fail = true;
  const sock = fakeSock();
  const r = routes({ ops }, { sock });
  assert.equal((await r.req('/crm/group/star', { jid: A, id: ID })).code, 503);
  assert.equal((await r.req('/crm/group/delete', { jid: A, id: ID })).code, 503);
  assert.equal(sock.calls.length, 0);
});

test('timeout do socket: UNKNOWN, sem segunda tentativa, nem depois de reiniciar', async () => {
  const dir = tmp();
  const ops = createOwnOps(dir);
  ops.record(A, ID, { timestamp: Math.floor(Date.now() / 1000) });
  const sock = fakeSock({ failStar: true });
  const s = await routes({ ops }, { sock }).req('/crm/group/star', { jid: A, id: ID });
  assert.equal(s.code, 502); assert.equal(s.data.outcome, 'UNKNOWN');
  const ops2 = createOwnOps(dir);
  const s2 = await routes({ ops: ops2 }, { sock }).req('/crm/group/star', { jid: A, id: ID });
  assert.equal(s2.data.duplicateSuppressed, true); assert.equal(sock.calls.length, 1);
});

test('mesmo id em dois grupos fica isolado; terceiros/privado/malformado nunca agem', async () => {
  const ops = createOwnOps(tmp());
  ops.record(A, ID, { timestamp: Math.floor(Date.now() / 1000) });
  const sock = fakeSock();
  const r = routes({ ops }, { sock });
  assert.equal((await r.req('/crm/group/star', { jid: B, id: ID })).code, 404);
  assert.equal((await r.req('/crm/group/star', { jid: '5511999999999@s.whatsapp.net', id: ID })).code, 400);
  assert.equal((await r.req('/crm/group/delete', { jid: A, id: 'x' })).code, 400);
  ops.observeRevoke(B, ID);
  assert.equal(ops.get(B, ID), null);
  assert.equal(sock.calls.length, 0);
});

// ---------- M2: reservas limitadas ----------
test('M2: reservas antigas vencem e o total fica limitado', () => {
  let agora = Date.now();
  const ops = createOwnOps(tmp(), { now: () => agora });
  for (let i = 0; i < 5100; i++) ops.reserve('k' + i, { phase: 'PERSISTED' });
  ops.saveStrict();
  assert.equal(Object.keys(ops.state().reservations).length, 5000);
  agora += 8 * 24 * 3600 * 1000;
  ops.saveStrict();
  assert.equal(Object.keys(ops.state().reservations).length, 0);
});

// ---------- envio com recibo (sendCrmText real, transporte falso) ----------
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const ini = server.indexOf('export function sanitizeSendError');
const fim = server.indexOf('\nconst AI = createAiEngine(', ini);
assert.ok(ini >= 0 && fim > ini, 'sendCrmText precisa existir');
const codigo = server.slice(ini, fim).replace('export function', 'function') + '\nthis.sendCrmText = sendCrmText; this.sanitizeSendError = sanitizeSendError;';
function sendFixture({ dir = tmp(), throwWith = null, ffs = null } = {}) {
  const calls = [];
  const ops = createOwnOps(dir, ffs ? { fs: ffs } : {});
  const sock = { sendMessage: async (jid) => { calls.push(jid); if (throwWith) throw new Error(throwWith); return { key: { id: ID, remoteJid: jid, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000) }; } };
  const CRM = { ops, state: { messages: {} }, upsertMessage: () => {} /* grupo arquivado: nao entra em messages */ };
  const sb = { sock, status: 'open', CRM, createHash, resolveOutboundJid: async x => x, marcarOrigem: () => {} };
  createContext(sb); new Script(codigo).runInContext(sb);
  return { send: sb.sendCrmText, sanitize: sb.sanitizeSendError, calls, ops, dir };
}

test('B1/N2: envio para grupo arquivado tem recibo; mesma chave depois de reiniciar devolve o mesmo id sem reenviar', async () => {
  const f = sendFixture();
  const r = await f.send(A, 'O.S', 'disp-0001-abcdef');
  assert.equal(r.ok, true); assert.equal(r.receiptPersisted, true);
  const f2 = sendFixture({ dir: f.dir });
  const r2 = await f2.send(A, 'O.S', 'disp-0001-abcdef');
  assert.equal(r2.ok, true); assert.equal(r2.duplicateSuppressed, true); assert.equal(r2.messageId, ID);
  assert.equal(f2.calls.length, 0);
});

test('B2: sem dispatchKey (chamadores antigos) o erro de limite continua sendo excecao com rate-overlimit', async () => {
  const f = sendFixture({ throwWith: 'rate-overlimit' });
  await assert.rejects(() => f.send(A, 'O.S'), /rate-overlimit/);
});

test('B2: com dispatchKey o limite volta UNKNOWN com causa sanitizada e nunca reenvia', async () => {
  const f = sendFixture({ throwWith: 'rate-overlimit' });
  const r = await f.send(A, 'O.S', 'disp-0002-abcdef');
  assert.equal(r.outcome, 'UNKNOWN'); assert.equal(r.cause, 'rate-overlimit'); assert.equal(r.limited, true);
  const r2 = await f.send(A, 'O.S', 'disp-0002-abcdef');
  assert.equal(r2.duplicateSuppressed, true); assert.equal(f.calls.length, 1);
});

test('M4: chave invalida e conflito sao REJECTED (nao enviado), sem efeito', async () => {
  const f = sendFixture();
  const r = await f.send(A, 'O.S', 'x');
  assert.equal(r.outcome, 'REJECTED'); assert.equal(r.httpStatus, 400); assert.equal(r.sent, false);
  await f.send(A, 'O.S', 'disp-0003-abcdef');
  const c = await f.send(A, 'outro texto', 'disp-0003-abcdef');
  assert.equal(c.outcome, 'REJECTED'); assert.equal(c.httpStatus, 409);
  assert.equal(f.calls.length, 1);
});

test('falha de disco: antes do envio = REJECTED sem efeito; depois do envio = UNKNOWN', async () => {
  const ffs = flakyFs(); ffs.fail = true;
  const f = sendFixture({ ffs });
  const r = await f.send(A, 'O.S', 'disp-0004-abcdef');
  assert.equal(r.outcome, 'REJECTED'); assert.equal(f.calls.length, 0);
  const ffs2 = flakyFs();
  const f2 = sendFixture({ ffs: ffs2 });
  const orig = f2.ops.saveStrict; let n = 0;
  f2.ops.saveStrict = () => { if (++n === 2) throw new Error('disk full'); return orig(); };
  const r2 = await f2.send(A, 'O.S', 'disp-0005-abcdef');
  assert.equal(r2.outcome, 'UNKNOWN'); assert.equal(r2.ok, false); assert.equal(f2.calls.length, 1);
});

test('N3: erro sanitizado nunca devolve JID, caminho ou texto bruto', () => {
  const { sanitize } = sendFixture();
  assert.equal(sanitize(new Error('Timed Out')), 'timeout');
  assert.equal(sanitize(new Error('rate-overlimit')), 'rate-overlimit');
  assert.equal(sanitize(new Error('falhou 5511999999999@s.whatsapp.net em C:/x/y.json')), 'whatsapp_send_failed');
  assert.equal(sanitize(new Error('whatsapp_not_connected')), 'whatsapp_not_connected');
});

test('B3: ai-engine nao marca auto_sent quando o envio volta ok:false', () => {
  const src = fs.readFileSync(new URL('../ai-engine.mjs', import.meta.url), 'utf8');
  assert.match(src, /enviado && enviado\.ok === false \? 'auto_send_unknown' : 'auto_sent'/);
});
