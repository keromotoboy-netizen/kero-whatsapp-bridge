import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

// Offline test: only the Baileys enum is stubbed; the production CRM store
// executes unchanged, with local temp files and no WhatsApp transport.
const source = fs.readFileSync(new URL('../crm-store.mjs', import.meta.url), 'utf8')
  .replace("import { WAMessageStubType } from 'baileys';", "const WAMessageStubType = { REVOKE: 68 };");
const { createCrmStore } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const jid = '1234567890-123456789@g.us', id = '3EB0SYNTHETICRECEIPT';
const original = () => ({ key: { remoteJid: jid, id, fromMe: true }, messageTimestamp: 20, message: { conversation: 'teste sintetico' } });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-bridge-receipts-'));
  const dataDir = path.join(root, 'auth');
  fs.mkdirSync(dataDir);
  const store = createCrmStore(dataDir);
  const ev = new EventEmitter();
  store.attach({ ev });
  store.upsertMessage(original());
  store.saveNow(true);
  return { root, dataDir, store, ev, item: () => store.state.messages[jid][0] };
}
test('observed starred event is saved durably and survives restart', async () => {
  const t = fixture();
  try {
    t.ev.emit('messages.update', [{ key: { remoteJid: jid, id }, update: { starred: true } }]);
    assert.equal(t.item().starred, true);
    assert.equal(t.item().starReceiptDurable, true);
    assert.ok(t.item().starObservedAt);
    const again = createCrmStore(t.dataDir);
    assert.equal(again.state.messages[jid][0].starReceiptDurable, true);
    assert.equal(again.state.messages[jid][0].starred, true);
  } finally { await new Promise(r => setTimeout(r, 300)); fs.rmSync(t.root, { recursive: true, force: true }); }
});
test('local messages.delete does not mean revoke for everyone; REVOKE event does', async () => {
  const t = fixture();
  try {
    t.ev.emit('messages.delete', { keys: [{ remoteJid: jid, id }] });
    assert.equal(t.item().deleted, true);
    assert.notEqual(t.item().deletedForEveryone, true);
    t.ev.emit('messages.update', [{ key: { remoteJid: jid, id }, update: { message: null, messageStubType: 68 } }]);
    assert.equal(t.item().deletedForEveryone, true);
    assert.equal(t.item().deleteReceiptDurable, true);
    const again = createCrmStore(t.dataDir);
    assert.equal(again.state.messages[jid][0].deleteReceiptDurable, true);
    assert.equal(again.state.messages[jid][0].deletedForEveryone, true);
  } finally { await new Promise(r => setTimeout(r, 300)); fs.rmSync(t.root, { recursive: true, force: true }); }
});
test('duplicate history upsert must not resurrect a deleted message', async () => {
  const t = fixture();
  try {
    t.ev.emit('messages.update', [{ key: { remoteJid: jid, id }, update: { message: null, messageStubType: 68 } }]);
    assert.equal(t.item().deleted, true);
    t.store.upsertMessage(original());
    assert.equal(t.item().deleted, true);
    assert.equal(t.item().deletedForEveryone, true);
    assert.equal(t.item().deleteReceiptDurable, true);
    t.store.saveNow(true);
    const again = createCrmStore(t.dataDir);
    assert.equal(again.state.messages[jid][0].deleted, true);
  } finally { await new Promise(r => setTimeout(r, 300)); fs.rmSync(t.root, { recursive: true, force: true }); }
});
