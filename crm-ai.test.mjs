import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrmAi } from './crm-ai.mjs';

const fixture = ({ mode = 'off', automatic = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kero-crm-ai-'));
  const auth = path.join(root, 'auth');
  fs.mkdirSync(auth, { recursive: true });
  const messages = [];
  const crm = {
    getMessages: () => messages
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() { return { response: 'Posso ajudar com sua entrega. Qual é o endereço de retirada e entrega?' }; }
    };
  };
  const env = {
    CRM_AI_MODE: mode,
    CRM_AI_PROVIDER: 'ollama',
    CRM_AI_BASE_URL: 'http://ollama.invalid',
    CRM_AI_MODEL: 'llama3.2:3b',
    CRM_AI_AUTOMATIC_ALLOWED: automatic ? 'true' : 'false'
  };
  const ai = createCrmAi({ dataDir: auth, crm, env, fetchImpl, now: () => '2026-10-06T12:00:00.000Z' });
  return { root, ai, messages, calls };
};

test('default/off mode never calls provider', async () => {
  const { root, ai, calls } = fixture({ mode: 'off' });
  try {
    const result = await ai.processIncoming({ jid: '1@s.whatsapp.net', text: 'Oi' });
    assert.equal(result.action, 'none');
    assert.equal(calls.length, 0);
    assert.equal(ai.listAudits({}).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('suggestions mode stores suggestion before any send decision', async () => {
  const { root, ai, calls } = fixture({ mode: 'suggestions' });
  try {
    const jid = '2@s.whatsapp.net';
    const result = await ai.processIncoming({ jid, text: 'Preciso de uma entrega hoje' });
    assert.equal(result.action, 'suggest');
    assert.equal(calls.length, 1);
    const suggestions = ai.listSuggestions(jid, {});
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].id, result.suggestionId);
    assert.equal(suggestions[0].status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic mode is fail-closed for sensitive or quote-without-calculator cases', async () => {
  const { root, ai } = fixture({ mode: 'automatic', automatic: true });
  try {
    const sensitive = await ai.processIncoming({ jid: '3@s.whatsapp.net', text: 'Quero reclamar de uma cobrança e falar com advogado' });
    assert.equal(sensitive.action, 'handoff');
    assert.equal(sensitive.risk.sensitive, true);

    const quote = await ai.processIncoming({ jid: '4@s.whatsapp.net', text: 'Qual o valor desta entrega?' });
    assert.equal(quote.action, 'handoff');
    assert.equal(quote.risk.reasons.includes('quote_without_calculator'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic low-risk send requires explicit environment gate', async () => {
  const a = fixture({ mode: 'automatic', automatic: false });
  try {
    const blocked = await a.ai.processIncoming({ jid: '5@s.whatsapp.net', text: 'Tenho uma entrega para hoje' });
    assert.equal(blocked.action, 'suggest');
  } finally {
    fs.rmSync(a.root, { recursive: true, force: true });
  }

  const b = fixture({ mode: 'automatic', automatic: true });
  try {
    const allowed = await b.ai.processIncoming({ jid: '6@s.whatsapp.net', text: 'Tenho uma entrega para hoje' });
    assert.equal(allowed.action, 'send');
    assert.ok(allowed.suggestionId);
    assert.equal(b.ai.listSuggestions('6@s.whatsapp.net', {})[0].status, 'pending');
  } finally {
    fs.rmSync(b.root, { recursive: true, force: true });
  }
});

test('memory is limited to the latest 16 non-deleted messages', () => {
  const { root, ai, messages } = fixture({ mode: 'suggestions' });
  try {
    for (let i = 0; i < 25; i++) {
      messages.push({ fromMe: i % 2 === 0, text: 'm' + i, timestamp: i, deleted: false });
    }
    messages[24].deleted = true;
    const memory = ai.memoryFor('7@s.whatsapp.net');
    assert.equal(memory.length, 15);
    assert.equal(memory[0].content, 'm9');
    assert.equal(memory.at(-1).content, 'm23');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
