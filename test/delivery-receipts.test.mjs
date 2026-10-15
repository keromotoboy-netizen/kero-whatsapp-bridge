import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCrmStore } from '../crm-store.mjs';

test('outbound delivery receipts advance monotonically, without logging message content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ack-test-'));
  try {
    const auth = path.join(root, 'auth');
    fs.mkdirSync(auth, { recursive: true });
    const store = createCrmStore(auth);
    const jid = '5511900000000@s.whatsapp.net';
    const id = 'synthetic-ack-1';
    store.upsertMessage({
      key: { id, remoteJid: jid, fromMe: true },
      messageTimestamp: 100,
      message: { conversation: 'Teste sintético' }
    });
    const ev = new EventEmitter();
    store.attach({ ev });
    const receipt = value => ev.emit('messages.update', [{
      key: { remoteJid: jid, id, fromMe: true },
      update: { status: value }
    }]);
    const status = () => store.getMessages(jid, { limit: 10 }).messages[0].deliveryStatus;

    assert.equal(status(), undefined);
    receipt(1);
    assert.equal(status(), 1);
    receipt(2);
    assert.equal(status(), 2);
    receipt(3);
    assert.equal(status(), 3);
    receipt(1);
    assert.equal(status(), 3, 'late earlier ACK must not overwrite READ');
    receipt(7);
    assert.equal(status(), 3, 'unknown status must not overwrite last valid ACK');
    receipt('4');
    assert.equal(status(), 3, 'untyped status must not be trusted');
    receipt(4);
    assert.equal(status(), 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt for unknown id does not create synthetic message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ack-test-'));
  try {
    const auth = path.join(root, 'auth');
    fs.mkdirSync(auth, { recursive: true });
    const store = createCrmStore(auth);
    const ev = new EventEmitter();
    store.attach({ ev });
    const jid = '5511900000000@s.whatsapp.net';
    ev.emit('messages.update', [{ key: { remoteJid: jid, id: 'does-not-exist' }, update: { status: 3 } }]);
    assert.equal(store.getMessages(jid, { limit: 10 }).messages.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
