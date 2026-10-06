import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiEngine, classifySensitivity, fallbackSuggestion } from '../ai-engine.mjs';

const makeEngine = ({ automaticAllowed = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-crm-ai-'));
  const auth = path.join(root, 'auth');
  fs.mkdirSync(auth, { recursive: true });
  const sent = [];
  const crm = {
    getMessages: () => ({
      messages: [
        { fromMe: false, text: 'Olá' },
        { fromMe: true, text: 'Como posso ajudar?' }
      ]
    })
  };
  const engine = createAiEngine({
    dataDir: auth,
    crm,
    sendText: async (jid, text) => sent.push({ jid, text }),
    config: { provider: 'rules', automaticAllowed }
  });
  return { root, engine, sent };
};

const incoming = (text, jid = '5511999999999@s.whatsapp.net') => ({
  key: { id: 'msg-1', remoteJid: jid, fromMe: false },
  message: { conversation: text }
});

test('sensitive finance and security cases require handoff', () => {
  assert.equal(classifySensitivity('quero estorno no PIX').sensitive, true);
  assert.equal(classifySensitivity('me mande sua senha e código 2FA').sensitive, true);
  assert.equal(classifySensitivity('qual valor da entrega?').sensitive, false);
});

test('fallback suggestion asks for minimum quotation data', () => {
  const suggestion = fallbackSuggestion('quanto custa a entrega?');
  assert.match(suggestion, /retirada/i);
  assert.match(suggestion, /entrega/i);
});

test('suggestions mode persists suggestion, memory count and audit', async () => {
  const { engine, sent } = makeEngine();
  const jid = '5511999999999@s.whatsapp.net';
  engine.setMode('suggestions', jid);

  const item = await engine.handleIncoming(incoming('quanto custa?', jid));

  assert.equal(item.status, 'pending');
  assert.equal(item.memoryMessages, 2);
  assert.equal(engine.listSuggestions(jid, 10).length, 1);
  assert.equal(sent.length, 0);
  assert.ok(engine.listAudit(jid, 50).some(x => x.type === 'suggestion_created'));
});

test('automatic mode never sends sensitive cases even when gate is enabled', async () => {
  const { engine, sent } = makeEngine({ automaticAllowed: true });
  const jid = '5511988887777@s.whatsapp.net';
  engine.setMode('automatic', jid);

  const item = await engine.handleIncoming(incoming('preciso de estorno no pix', jid));

  assert.equal(item.status, 'pending');
  assert.equal(item.risk.sensitive, true);
  assert.equal(sent.length, 0);
  assert.ok(engine.listAudit(jid, 50).some(x => x.type === 'automatic_blocked_sensitive'));
});

test('automatic mode can send a non-sensitive suggestion only when explicit gate is enabled', async () => {
  const { engine, sent } = makeEngine({ automaticAllowed: true });
  const jid = '5511977776666@s.whatsapp.net';
  engine.setMode('automatic', jid);

  const item = await engine.handleIncoming(incoming('quanto custa?', jid));

  assert.equal(item.status, 'auto_sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, jid);
  assert.ok(engine.listAudit(jid, 50).some(x => x.type === 'automatic_sent'));
});
