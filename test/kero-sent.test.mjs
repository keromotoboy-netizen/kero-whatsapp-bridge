import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WAMessageStubType } from 'baileys';
import { createCrmStore } from '../crm-store.mjs';

const make = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-sent-'));
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth, { recursive: true });
  return { auth, store: createCrmStore(auth) };
};
const agora = () => Math.floor(Date.now() / 1000);
const msg = ({ id, jid, fromMe, ts = agora(), text = 'oi', message }) => ({ key: { id, remoteJid: jid, fromMe, participant: fromMe ? undefined : '1@s.whatsapp.net' }, messageTimestamp: ts, message: message || { conversation: text } });
const G = '120363000000000001@g.us';
const OS = '🔰12 KM 🔛R$25,00\n*Retirada:* A\n*Entrega:* B';

test('grupo arquivado: guarda so as mensagens da Kero (inclusive do celular), nunca de terceiros', () => {
  const { store } = make();
  store.upsertChat({ id: G, archived: true });
  store.upsertMessage(msg({ id: 'K1', jid: G, fromMe: true, text: OS }), { countUnread: false }); // celular (append)
  store.upsertMessage(msg({ id: 'O1', jid: G, fromMe: false, text: OS }));
  const r = store.keroSent({ sinceHours: 58 });
  assert.deepEqual(r.messages.map(m => m.id), ['K1']);
  assert.equal(r.messages[0].archived, true);
  assert.equal(r.messages[0].text, OS);
  assert.equal(store.getMessages(G, { limit: 10 }).messages.length, 0); // regra 20/10 continua: nada no historico do arquivado
});

test('nao guarda conversa privada, protocolo de apagar, nem mensagem com mais de 62 h', () => {
  const { store } = make();
  store.upsertMessage(msg({ id: 'P1', jid: '5511999999999@s.whatsapp.net', fromMe: true, text: OS }));
  store.upsertMessage(msg({ id: 'R1', jid: G, fromMe: true, message: { protocolMessage: { type: 0, key: { id: 'K9' } } } }));
  store.upsertMessage(msg({ id: 'V1', jid: G, fromMe: true, ts: agora() - 63 * 3600, text: OS }));
  assert.equal(store.keroSent({ sinceHours: 62 }).total, 0);
});

test('apagada para todos (update REVOKE, messages.delete e rota) fica marcada', () => {
  const { store } = make();
  store.upsertChat({ id: G, archived: true });
  for (const id of ['A', 'B', 'C']) store.upsertMessage(msg({ id, jid: G, fromMe: true, text: OS }));
  const handlers = {}; store.attach({ ev: { on: (n, f) => { handlers[n] = f; } } });
  handlers['messages.update']([{ key: { remoteJid: G, id: 'A', fromMe: true }, update: { message: null, messageStubType: WAMessageStubType.REVOKE } }]);
  handlers['messages.delete']({ keys: [{ remoteJid: G, id: 'B' }] });
  assert.equal(store.marcarKeroSentApagada(G, 'C'), true);
  assert.deepEqual(store.keroSent().messages.map(m => [m.id, m.deleted]), [['A', true], ['B', true], ['C', true]]);
});

test('sobrevive a reinicio (vai junto no crm-state.json) e respeita sinceHours', () => {
  const { auth, store } = make();
  store.upsertMessage(msg({ id: 'N1', jid: G, fromMe: true, ts: agora() - 2 * 3600, text: OS }));
  store.upsertMessage(msg({ id: 'N2', jid: G, fromMe: true, ts: agora() - 30 * 3600, text: OS }));
  store.saveNow();
  const de_novo = createCrmStore(auth);
  assert.deepEqual(de_novo.keroSent({ sinceHours: 58 }).messages.map(m => m.id), ['N2', 'N1']);
  assert.deepEqual(de_novo.keroSent({ sinceHours: 10 }).messages.map(m => m.id), ['N1']);
});
