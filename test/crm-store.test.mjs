import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCrmStore } from '../crm-store.mjs';

const makeStore = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-crm-store-'));
  const auth = path.join(root, 'auth');
  fs.mkdirSync(auth, { recursive: true });
  return { root, store: createCrmStore(auth) };
};

const message = ({ id, jid = '5511999999999@s.whatsapp.net', ts, fromMe = false, text = 'oi', extra = {} }) => ({
  key: { id, remoteJid: jid, fromMe },
  messageTimestamp: ts,
  message: { conversation: text, ...extra }
});

test('history replay is idempotent for unread and does not regress last message time', () => {
  const { store } = makeStore();
  const jid = '5511999999999@s.whatsapp.net';

  store.upsertMessage(message({ id: 'm-new', jid, ts: 200, text: 'nova' }));
  store.upsertMessage(message({ id: 'm-new', jid, ts: 200, text: 'nova' }));
  store.upsertMessage(message({ id: 'm-old', jid, ts: 100, text: 'antiga' }), { countUnread: false });

  const snap = store.snapshot();
  assert.equal(snap.chats.length, 1);
  assert.equal(snap.chats[0].unreadCount, 1);
  assert.equal(snap.chats[0].lastMessageTimestamp, 200);
  assert.equal(snap.chats[0].lastMessage, 'nova');
});

test('LID and PN collapse into one canonical chat and PN contact name wins', () => {
  const { store } = makeStore();
  const lid = '123456789@lid';
  const pn = '5511988887777@s.whatsapp.net';

  store.upsertContact({ id: lid, name: 'Nome LID' });
  store.upsertContact({ id: pn, name: 'Cliente Real' });
  store.upsertChat({ id: lid, unreadCount: 3, lastMessageTimestamp: 100, lastMessage: 'lid' });
  store.upsertChat({ id: pn, unreadCount: 1, lastMessageTimestamp: 200, lastMessage: 'pn' });
  store.upsertLidMapping({ lid, pn });

  const snap = store.snapshot();
  assert.equal(snap.chats.length, 1);
  assert.equal(snap.chats[0].id, pn);
  assert.equal(snap.chats[0].name, 'Cliente Real');
  assert.equal(snap.chats[0].unreadCount, 3);
  assert.equal(snap.chats[0].lastMessage, 'pn');
});

test('message history paginates beyond the previous 500-message ceiling', () => {
  const { store } = makeStore();
  const jid = '5511977776666@s.whatsapp.net';

  for (let i = 1; i <= 600; i++) {
    store.upsertMessage(message({ id: 'm' + i, jid, ts: i, text: 'msg ' + i }), { countUnread: false });
  }

  const first = store.getMessages(jid, { limit: 120 });
  assert.equal(first.total, 600);
  assert.equal(first.messages.length, 120);
  assert.equal(first.messages[0].timestamp, 481);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, 481);

  const second = store.getMessages(jid, { limit: 120, before: first.nextBefore });
  assert.equal(second.messages.length, 120);
  assert.equal(second.messages[0].timestamp, 361);
  assert.equal(second.messages.at(-1).timestamp, 480);
});

test('messages.update refreshes live location coordinates', () => {
  const { store } = makeStore();
  const jid = '5511966665555@s.whatsapp.net';
  const id = 'loc-1';

  store.upsertMessage({
    key: { id, remoteJid: jid, fromMe: false },
    messageTimestamp: 100,
    message: {
      liveLocationMessage: {
        degreesLatitude: -23.55,
        degreesLongitude: -46.63,
        accuracyInMeters: 10,
        sequenceNumber: 1
      }
    }
  });

  const ev = new EventEmitter();
  store.attach({ ev });
  ev.emit('messages.update', [{
    key: { id, remoteJid: jid, fromMe: false },
    update: {
      message: {
        liveLocationMessage: {
          degreesLatitude: -23.551,
          degreesLongitude: -46.631,
          accuracyInMeters: 5,
          sequenceNumber: 2
        }
      }
    }
  }]);

  const page = store.getMessages(jid, { limit: 10 });
  assert.equal(page.messages[0].location.latitude, -23.551);
  assert.equal(page.messages[0].location.longitude, -46.631);
  assert.equal(page.messages[0].location.sequenceNumber, 2);
  assert.equal(page.messages[0].location.live, true);
});

test('received image exposes safe preview metadata and thumbnail', () => {
  const { store } = makeStore();
  const jid = '5511955554444@s.whatsapp.net';

  store.upsertMessage({
    key: { id: 'img-1', remoteJid: jid, fromMe: false },
    messageTimestamp: 100,
    message: {
      imageMessage: {
        caption: 'foto',
        mimetype: 'image/jpeg',
        width: 640,
        height: 480,
        fileLength: 1234,
        jpegThumbnail: Buffer.from('thumbnail')
      }
    }
  });

  const item = store.getMessages(jid, { limit: 10 }).messages[0];
  assert.equal(item.media.kind, 'image');
  assert.equal(item.media.mimetype, 'image/jpeg');
  assert.equal(item.media.width, 640);
  assert.equal(item.media.height, 480);
  assert.match(item.media.thumbnail, /^data:image\/jpeg;base64,/);
});

test('archive filter returns archived chats independently from active chats', () => {
  const { store } = makeStore();
  store.upsertChat({ id: '5511944443333@s.whatsapp.net', archived: false });
  store.upsertChat({ id: '5511933332222@s.whatsapp.net', archived: true });

  assert.equal(store.snapshot({ archived: false }).chats.length, 1);
  assert.equal(store.snapshot({ archived: true }).chats.length, 1);
});

test('conversas arquivadas nao guardam mensagens e sao podadas ao carregar', () => {
  const { root, store } = makeStore();
  const ativa = '5511911110000@s.whatsapp.net';
  const arquivada = '5511922220000@s.whatsapp.net';
  store.upsertMessage(message({ id: 'a1', jid: ativa, ts: 10, text: 'ativa' }));
  store.upsertMessage(message({ id: 'b1', jid: arquivada, ts: 10, text: 'antes' }));
  store.upsertChat({ id: arquivada, archived: true });
  assert.equal(store.getMessages(arquivada, { limit: 50 }).total, 0);
  store.upsertMessage(message({ id: 'b2', jid: arquivada, ts: 20, text: 'depois' }));
  assert.equal(store.getMessages(arquivada, { limit: 50 }).total, 0);
  assert.equal(store.getMessages(ativa, { limit: 50 }).total, 1);
  store.saveNow();
  // estado salvo com mensagens antigas de arquivada deve ser podado ao carregar
  const file = path.join(root, 'crm-state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.messages[arquivada] = [{ id: 'x', timestamp: 1, text: 'velha' }];
  fs.writeFileSync(file, JSON.stringify(saved));
  const reloaded = createCrmStore(path.join(root, 'auth'));
  assert.equal(reloaded.getMessages(arquivada, { limit: 50 }).total, 0);
  assert.equal(reloaded.getMessages(ativa, { limit: 50 }).total, 1);
});

test('KERO-BUSCA-CARTOES-20261109: cartao com sufixo :0 junta no numero base; busca por nome salvo, apelido e numero', () => {
  const { store } = makeStore();
  const base = '5513991234567@s.whatsapp.net', dev = '5513991234567:0@s.whatsapp.net';
  store.upsertContact({ id: base, name: 'Cliente João Esquina Brasil', notify: 'Nil' });
  store.upsertChat({ id: base, archived: true, unreadCount: 0, conversationTimestamp: 1000 });
  store.upsertMessage(message({ id: 'velha1', jid: base, ts: 1000, text: 'pedido antigo' }));
  store.upsertMessage(message({ id: 'nova1', jid: dev, ts: Math.floor(Date.now() / 1000), text: 'Abre as 8 fecha 12h' }), { countUnread: true });
  const chats = store.snapshot({ archived: false, search: '', limit: 0 }).chats.filter(c => c.id.startsWith('551399123'));
  assert.equal(chats.length, 1, 'um cartao so');
  assert.equal(chats[0].id, base);
  assert.equal(chats[0].name, 'Cliente João Esquina Brasil');
  for (const q of ['esquina', 'Joao Esquina', 'nil', '99123-4567', '13991234567']) {
    assert.equal(store.snapshot({ archived: false, search: q, limit: 0 }).chats.filter(c => c.id === base).length, 1, 'busca: ' + q);
  }
  const ids = store.getMessages(base, { limit: 50 }).messages.map(m => m.id);
  assert.ok(ids.includes('nova1'), 'mensagem da variante :0 aparece no numero base'); // conversa arquivada nao guarda mensagem local (regra antiga)
});
