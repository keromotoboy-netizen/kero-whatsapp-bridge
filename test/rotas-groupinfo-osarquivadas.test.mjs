// KERO 15/11/2026: testes das rotas /crm/group-info e /crm/os-arquivadas (WhatsApp e CRM falsos; nada real).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bloco = src.slice(src.indexOf('// KERO-ROTAS-20261115-INI'), src.indexOf('// KERO-ROTAS-20261115-FIM'));
function monta({ sock, status = 'open', msgs = [], grupos = {} } = {}) {
  const rotas = {}; const app = { get: (p, _s, h) => { rotas[p] = h; } };
  const CRM = { keroSent: ({ sinceHours }) => ({ sinceHours, total: msgs.length, messages: msgs }), state: { groups: grupos } };
  new Function('app', 'secure', 'sock', 'status', 'CRM', bloco)(app, () => {}, sock, status, CRM);
  return rotas;
}
const chama = async (h, query = {}) => { let code = 200, body; const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } }; await h({ query }, res); return { code, body }; };

test('rotas existem uma vez, protegidas pela chave (secure)', () => {
  for (const r of ['/crm/group-info', '/crm/os-arquivadas']) { assert.ok(src.includes("app.get('" + r + "', secure"), r); assert.equal(src.split("app.get('" + r + "'").length - 1, 1, r + ' duplicada'); }
});
test('group-info: pede jid de grupo; sem WhatsApp conectado devolve 409', async () => {
  const r = monta({ sock: { groupMetadata: async () => ({}) } });
  assert.equal((await chama(r['/crm/group-info'], { jid: '5511999990000@s.whatsapp.net' })).code, 400);
  const off = monta({ sock: { groupMetadata: async () => ({}) }, status: 'connecting' });
  assert.equal((await chama(off['/crm/group-info'], { jid: '1203@g.us' })).code, 409);
});
test('group-info: devolve nome/descricao; membros so com ?participantes=1 (id, lid e numero)', async () => {
  const meta = { subject: 'Grupo 1,50', desc: 'regras', participants: [{ id: '123@lid', phoneNumber: '5511988887777@s.whatsapp.net' }, { id: '5511977776666@s.whatsapp.net' }] };
  const r = monta({ sock: { groupMetadata: async jid => { assert.equal(jid, '1203@g.us'); return meta; } } });
  const a = await chama(r['/crm/group-info'], { jid: '1203@g.us' });
  assert.equal(a.code, 200); assert.equal(a.body.subject, 'Grupo 1,50'); assert.equal(a.body.participantes, undefined);
  const b = await chama(r['/crm/group-info'], { jid: '1203@g.us', participantes: '1' });
  assert.equal(b.body.participantes.length, 2);
  assert.deepEqual(b.body.participantes[0], { id: '123@lid', lid: '123@lid', numero: '5511988887777@s.whatsapp.net' });
  assert.deepEqual(b.body.participantes[1], { id: '5511977776666@s.whatsapp.net', lid: null, numero: '5511977776666@s.whatsapp.net' });
});
test('group-info: erro do WhatsApp vira 502 sem derrubar a ponte', async () => {
  const r = monta({ sock: { groupMetadata: async () => { throw new Error('boom'); } } });
  const x = await chama(r['/crm/group-info'], { jid: '1203@g.us' }); assert.equal(x.code, 502); assert.equal(x.body.error, 'group_info_failed');
});
test('os-arquivadas: so O.S. da Kero, em grupo arquivado, nao apagada; com nome do grupo; texto cortado', async () => {
  const OS = '🔰 12 KM 🔛 R$ 25,00\n📍 Retirada: Pirituba';
  const msgs = [
    { jid: 'a@g.us', id: '1', timestamp: 100, text: OS, deleted: false, archived: true },
    { jid: 'a@g.us', id: '2', timestamp: 101, text: OS, deleted: true, archived: true },
    { jid: 'b@g.us', id: '3', timestamp: 102, text: OS, deleted: false, archived: false },
    { jid: 'a@g.us', id: '4', timestamp: 103, text: 'bom dia, tudo bem?', deleted: false, archived: true },
    { jid: 'a@g.us', id: '5', timestamp: 104, text: OS + 'x'.repeat(900), deleted: false, archived: true }];
  const r = monta({ sock: null, msgs, grupos: { 'a@g.us': { subject: 'Grupo A' } } });
  const x = await chama(r['/crm/os-arquivadas']);
  assert.equal(x.code, 200); assert.equal(x.body.ok, true); assert.deepEqual(x.body.os.map(o => o.id), ['1', '5']);
  assert.equal(x.body.os[0].grupo, 'Grupo A'); assert.equal(x.body.os[0].deleted, false); assert.ok(x.body.os[1].text.length <= 400);
  assert.equal(x.body.total, 2);
});
test('os-arquivadas: sem nada arquivado devolve lista vazia (a varredura entende como "nada sobrou")', async () => {
  const x = await chama(monta({ sock: null, msgs: [] })['/crm/os-arquivadas']); assert.deepEqual(x.body.os, []); assert.equal(x.body.total, 0);
});
