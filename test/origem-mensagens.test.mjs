// KERO-ORIGEM-20261108 (item 18): mensagem nossa ganha origem 'ia' | 'api' | 'humano'; mensagem do cliente fica sem origem.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrmStore } from '../crm-store.mjs';

const makeStore = (opts = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-crm-origem-'));
  const auth = path.join(root, 'auth');
  fs.mkdirSync(auth, { recursive: true });
  return createCrmStore(auth, opts);
};
const jid = '5511999999999@s.whatsapp.net';
const msg = (id, fromMe, text = 'oi') => ({ key: { id, remoteJid: jid, fromMe }, messageTimestamp: 1000, message: { conversation: text } });

test('origem: ia quando o envio foi marcado, humano quando nao, nula para mensagem do cliente', () => {
  const marcados = new Map([['IA1', 'ia'], ['API1', 'api']]);
  const store = makeStore({ origemDe: id => marcados.get(String(id)) || null });
  store.upsertMessage(msg('IA1', true, 'orcamento R$ 50'));
  store.upsertMessage(msg('API1', true, 'disparo do painel'));
  store.upsertMessage(msg('HUM1', true, 'oi, sou a Victoria'));
  store.upsertMessage(msg('CLI1', false, 'quanto fica?'));
  const por = Object.fromEntries((store.getMessages(jid, { limit: 10 }).messages || []).map(m => [m.id, m.origem]));
  assert.equal(por.IA1, 'ia');
  assert.equal(por.API1, 'api');
  assert.equal(por.HUM1, 'humano');
  assert.equal(por.CLI1, null);
});

test('origem: evento do WhatsApp chega antes da marcacao e depois e corrigido para ia', () => {
  const marcados = new Map();
  const store = makeStore({ origemDe: id => marcados.get(String(id)) || null });
  store.upsertMessage(msg('X1', true, 'texto'));            // evento messages.upsert chegou primeiro: ainda 'humano'
  marcados.set('X1', 'ia');
  store.upsertMessage(msg('X1', true, 'texto'));            // sendCrmText -> marcarOrigem + upsert: vira 'ia'
  const m = (store.getMessages(jid, { limit: 10 }).messages || []).find(x => x.id === 'X1');
  assert.equal(m.origem, 'ia');
});

test('origem: sem origemDe o store continua funcionando (humano para nossas, nula para clientes)', () => {
  const store = makeStore();
  store.upsertMessage(msg('A', true));
  store.upsertMessage(msg('B', false));
  const por = Object.fromEntries((store.getMessages(jid, { limit: 10 }).messages || []).map(m => [m.id, m.origem]));
  assert.equal(por.A, 'humano');
  assert.equal(por.B, null);
});
