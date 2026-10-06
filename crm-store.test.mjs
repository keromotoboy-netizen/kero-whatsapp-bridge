import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrmStore } from './crm-store.mjs';

const tempStore = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-crm-test-'));
  const auth = path.join(root, 'auth');
  fs.mkdirSync(auth, { recursive: true });
  const store = createCrmStore(auth);
  return { root, store };
};

const msg = ({ jid = '5511999999999@s.whatsapp.net', id, ts, text = 'x', fromMe = false, message = null }) => ({
  key: { remoteJid: jid, id, fromMe },
  messageTimestamp: ts,
  message: message || { conversation: text }
});

test('history is idempotent and never regresses lastMessageTimestamp', () => {
  const { root, store } = tempStore();
  try {
    const jid = '5511999999999@s.whatsapp.net';
    store.upsertMessage(msg({ jid, id: 'new', ts: 200, text: 'mais nova' }), { countUnread: true });
    store.upsertMessage(msg({ jid, id: 'old', ts: 100, text: 'antiga' }), { countUnread: false });
    store.upsertMessage(msg({ jid, id: 'new', ts: 200, text: 'mais nova' }), { countUnread: true });

    const chat = store.snapshot().chats.find(x => x.id === jid);
    assert.equal(chat.unreadCount, 1);
    assert.equal(chat.lastMessageTimestamp, 200);
    assert.equal(chat.lastMessage, 'mais nova');

    store.upsertChat({ id: jid, archived: true, unreadCount: 99, conversationTimestamp: 50, lastMessage: 'velha' }, { historical: true });
    const afterHistory = store.snapshot().chats.find(x => x.id === jid);
    assert.equal(afterHistory.archived, false);
    assert.equal(afterHistory.unreadCount, 1);
    assert.equal(afterHistory.lastMessageTimestamp, 200);
    assert.equal(afterHistory.lastMessage, 'mais nova');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PN contact name wins over LID placeholder while LID remains addressable', () => {
  const { root, store } = tempStore();
  try {
    const pn = '551188887777@s.whatsapp.net';
    const lid = '123456789@lid';
    store.upsertContact({ id: lid, name: 'Contato LID provisório' });
    store.upsertContact({ id: pn, name: 'Cliente Salvo PN' });
    store.upsertLidMapping({ pn, lid });
    store.upsertMessage(msg({ jid: lid, id: 'm1', ts: 10, text: 'oi' }), { countUnread: false });

    const chat = store.snapshot().chats.find(x => x.id === lid);
    assert.equal(chat.name, 'Cliente Salvo PN');
    assert.equal(store.resolveSendJid(lid), pn);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('messages.update refreshes live location monotonically', () => {
  const { root, store } = tempStore();
  try {
    const jid = '551177776666@s.whatsapp.net';
    store.upsertMessage(msg({
      jid,
      id: 'loc1',
      ts: 100,
      message: {
        liveLocationMessage: {
          degreesLatitude: -23.55,
          degreesLongitude: -46.63,
          sequenceNumber: 1,
          accuracyInMeters: 20
        }
      }
    }), { countUnread: false });

    store.handleMessageUpdates([{
      key: { remoteJid: jid, id: 'loc1' },
      update: {
        message: {
          liveLocationMessage: {
            degreesLatitude: -23.551,
            degreesLongitude: -46.631,
            sequenceNumber: 2,
            accuracyInMeters: 8,
            speedInMps: 4
          }
        }
      }
    }]);

    let item = store.getMessages(jid, 10)[0];
    assert.equal(item.location.sequenceNumber, 2);
    assert.equal(item.location.latitude, -23.551);
    assert.equal(item.location.accuracy, 8);
    assert.equal(item.location.speed, 4);
    assert.equal(item.location.live, true);

    store.handleMessageUpdates([{
      key: { remoteJid: jid, id: 'loc1' },
      update: {
        message: {
          liveLocationMessage: {
            degreesLatitude: 1,
            degreesLongitude: 1,
            sequenceNumber: 1
          }
        }
      }
    }]);

    item = store.getMessages(jid, 10)[0];
    assert.equal(item.location.sequenceNumber, 2);
    assert.equal(item.location.latitude, -23.551);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('received media exposes safe preview metadata and thumbnail', () => {
  const { root, store } = tempStore();
  try {
    const jid = '551166665555@s.whatsapp.net';
    store.upsertMessage(msg({
      jid,
      id: 'img1',
      ts: 100,
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: 'Comprovante',
          width: 640,
          height: 480,
          fileLength: 12345,
          jpegThumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
        }
      }
    }), { countUnread: false });

    const item = store.getMessages(jid, 10)[0];
    assert.equal(item.media.kind, 'image');
    assert.equal(item.media.mimetype, 'image/jpeg');
    assert.equal(item.media.caption, 'Comprovante');
    assert.equal(item.media.width, 640);
    assert.equal(item.media.height, 480);
    assert.equal(item.media.fileLength, 12345);
    assert.match(item.media.thumbnail, /^data:image\/jpeg;base64,/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('message history is not truncated at 500 and supports backward pagination', () => {
  const { root, store } = tempStore();
  try {
    const jid = '551155554444@s.whatsapp.net';
    for (let i = 1; i <= 620; i++) {
      store.upsertMessage(msg({ jid, id: 'm' + i, ts: i, text: 'msg ' + i }), { countUnread: false });
    }

    assert.equal(store.state.messages[jid].length, 620);

    const page1 = store.getMessagesPage(jid, { limit: 100 });
    assert.equal(page1.messages.length, 100);
    assert.equal(page1.messages[0].id, 'm521');
    assert.equal(page1.messages.at(-1).id, 'm620');
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextBefore, 521);

    const page2 = store.getMessagesPage(jid, { limit: 100, before: page1.nextBefore });
    assert.equal(page2.messages[0].id, 'm421');
    assert.equal(page2.messages.at(-1).id, 'm520');
    assert.equal(page2.hasMore, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
