import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_RULES = [
  'Nunca inventar preço, prazo, disponibilidade, motorista, status de entrega ou avaliação.',
  'Para orçamento, pedir origem, destino, tipo de volume/veículo e horário quando essas informações faltarem.',
  'Dados financeiros, reembolsos, disputas, reclamações graves, questões jurídicas, acidentes, emergências e credenciais exigem handoff humano.',
  'Não pedir senha, código de autenticação, token, chave de API ou dado bancário sensível.',
  'Em modo automático, só enviar quando o gate do servidor estiver habilitado e o caso não for sensível.',
  'Preservar contexto recente da mesma conversa e não misturar dados entre chats.',
  'Quando não houver informação suficiente, dizer que irá verificar ou pedir os dados mínimos necessários.'
];

const unwrapMessage = message => {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  return message;
};

const incomingText = raw => {
  const m = unwrapMessage(raw?.message);
  if (!m) return '';
  return String(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
};

export function classifySensitivity(text) {
  const value = String(text || '');
  const checks = [
    ['financeiro', /\b(pix|boleto|estorno|reembolso|chargeback|cobran[cç]a|dados? banc[aá]rios?|cart[aã]o)\b/i],
    ['seguranca', /\b(senha|token|c[oó]digo de verifica[cç][aã]o|2fa|otp|chave de api)\b/i],
    ['juridico', /\b(advogad|processo|procon|jur[ií]dic|pol[ií]cia|boletim de ocorr[eê]ncia)\b/i],
    ['incidente', /\b(acidente|roubo|furto|amea[cç]a|emerg[eê]ncia|machucad|hospital)\b/i],
    ['reclamacao_grave', /\b(fraude|golpe|indeniza[cç][aã]o|reclama[cç][aã]o grave|nunca chegou|sumiu)\b/i]
  ];
  const reasons = checks.filter(([, rx]) => rx.test(value)).map(([name]) => name);
  return { sensitive: reasons.length > 0, reasons };
}

export function fallbackSuggestion(text) {
  const value = String(text || '').trim();
  if (/^(oi|ol[aá]|bom dia|boa tarde|boa noite)\b/i.test(value)) {
    return 'Olá! Aqui é da Kero Motoboy. Como posso ajudar com sua entrega hoje?';
  }
  if (/\b(pre[cç]o|valor|or[cç]amento|quanto custa|cot[aã]o)\b/i.test(value)) {
    return 'Claro. Para calcular corretamente, me envie o endereço de retirada, o endereço de entrega, o tipo de volume e o horário desejado.';
  }
  if (/\b(status|andamento|onde est[aá]|cad[eê]|chegou|entrega)\b/i.test(value)) {
    return 'Posso verificar o andamento. Informe o nome da empresa/cliente ou alguma referência da entrega, por favor.';
  }
  if (/\b(dispon[ií]vel|consegue|tem motoboy|preciso de motoboy)\b/i.test(value)) {
    return 'Posso verificar a melhor opção. Me passe retirada, destino, horário desejado e o tipo de volume.';
  }
  return 'Recebi sua mensagem. Para eu orientar corretamente, pode me passar um pouco mais de detalhe sobre a coleta ou entrega que precisa?';
}

const normalizeMode = mode =>
  ['off', 'suggestions', 'automatic'].includes(String(mode || '')) ? String(mode) : null;

export function createAiEngine({
  dataDir,
  crm,
  sendText,
  fetchImpl = globalThis.fetch,
  config = {}
}) {
  const file = path.join(path.dirname(dataDir), 'crm-ai-state.json');
  let state = {
    version: 1,
    globalMode: 'off',
    modes: {},
    suggestions: {},
    audit: []
  };

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { ...state, ...parsed };
    }
  } catch (error) {
    console.error('[ai] failed to load state', error?.message || error);
  }

  const provider = String(
    config.provider ??
    process.env.AI_PROVIDER ??
    (process.env.AI_OLLAMA_URL ? 'ollama' : 'rules')
  ).toLowerCase();
  const ollamaUrl = String(config.ollamaUrl ?? process.env.AI_OLLAMA_URL ?? '').replace(/\/$/, '');
  const model = String(config.model ?? process.env.AI_MODEL ?? 'llama3.2:3b');
  const automaticAllowed =
    config.automaticAllowed ??
    String(process.env.AI_AUTOMATIC_ALLOWED || '') === '1';
  const rules = Array.isArray(config.rules) && config.rules.length ? config.rules : DEFAULT_RULES;

  const save = () => {
    state.audit = (state.audit || []).slice(-2000);
    for (const jid of Object.keys(state.suggestions || {})) {
      state.suggestions[jid] = (state.suggestions[jid] || []).slice(-100);
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  };

  const providerStatus = () => ({
    name: provider === 'ollama' ? 'ollama' : 'kero-rules-v1',
    configured: provider === 'rules' || (provider === 'ollama' && !!ollamaUrl),
    model: provider === 'ollama' ? model : 'deterministic-safe-fallback',
    automaticAllowed: !!automaticAllowed,
    cost: 'FREE_MAX'
  });

  const audit = entry => {
    state.audit.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...entry
    });
    save();
  };

  const status = jid => {
    const globalMode = normalizeMode(state.globalMode) || 'off';
    const mode = jid ? (normalizeMode(state.modes[jid]) || globalMode) : globalMode;
    return { mode, globalMode, provider: providerStatus(), rulesCount: rules.length };
  };

  const setMode = (mode, jid = null) => {
    const normalized = normalizeMode(mode);
    if (!normalized) throw new Error('invalid_ai_mode');
    if (jid) state.modes[jid] = normalized;
    else state.globalMode = normalized;
    audit({ type: 'mode_changed', jid: jid || null, mode: normalized });
    return status(jid);
  };

  const listSuggestions = (jid, limit = 20) => {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return (state.suggestions[jid] || []).slice(-safeLimit);
  };

  const reviewSuggestion = (jid, id, nextStatus) => {
    const allowed = new Set(['approved', 'rejected', 'sent', 'auto_sent']);
    if (!allowed.has(String(nextStatus))) throw new Error('invalid_suggestion_status');
    const item = (state.suggestions[jid] || []).find(x => x.id === id);
    if (!item) throw new Error('suggestion_not_found');
    item.status = String(nextStatus);
    item.reviewedAt = new Date().toISOString();
    audit({ type: 'suggestion_reviewed', jid, suggestionId: id, status: item.status });
    return item;
  };

  const listAudit = (jid = null, limit = 100) => {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const items = jid ? state.audit.filter(x => x.jid === jid) : state.audit;
    return items.slice(-safeLimit);
  };

  const promptFor = (jid, text) => {
    const page = crm.getMessages(jid, { limit: 12 });
    const memory = (page.messages || [])
      .map(m => `${m.fromMe ? 'Kero' : 'Cliente'}: ${String(m.text || '').slice(0, 600)}`)
      .join('\n');
    return [
      'Você sugere respostas curtas em português do Brasil para atendimento da Kero Motoboy.',
      'Regras obrigatórias:',
      ...rules.map((rule, i) => `${i + 1}. ${rule}`),
      '',
      'Memória curta desta conversa:',
      memory || '(sem histórico suficiente)',
      '',
      'Mensagem atual do cliente:',
      text,
      '',
      'Responda somente com a sugestão de resposta, sem explicações.'
    ].join('\n');
  };

  const generate = async (jid, text) => {
    if (provider === 'ollama' && ollamaUrl) {
      const response = await fetchImpl(ollamaUrl + '/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: promptFor(jid, text),
          stream: false,
          options: { temperature: 0.2, num_predict: 180 }
        }),
        signal: AbortSignal.timeout(45000)
      });
      if (!response.ok) throw new Error('ollama_http_' + response.status);
      const body = await response.json();
      const value = String(body?.response || '').trim();
      if (!value) throw new Error('ollama_empty_response');
      return { text: value, provider: 'ollama', model };
    }

    return {
      text: fallbackSuggestion(text),
      provider: 'kero-rules-v1',
      model: 'deterministic-safe-fallback'
    };
  };

  const handleIncoming = async raw => {
    const jid = String(raw?.key?.remoteJid || '');
    if (!jid || raw?.key?.fromMe || jid === 'status@broadcast') return null;

    const current = status(jid);
    if (current.mode === 'off') {
      audit({ type: 'incoming_ignored_ai_off', jid, messageId: raw?.key?.id || null });
      return null;
    }

    const text = incomingText(raw);
    if (!text) {
      audit({ type: 'incoming_without_text', jid, messageId: raw?.key?.id || null });
      return null;
    }

    const risk = classifySensitivity(text);
    let generated;
    try {
      generated = await generate(jid, text);
    } catch (error) {
      generated = {
        text: fallbackSuggestion(text),
        provider: 'kero-rules-v1-fallback',
        model: 'deterministic-safe-fallback'
      };
      audit({
        type: 'provider_fallback',
        jid,
        messageId: raw?.key?.id || null,
        error: String(error?.message || error).slice(0, 300)
      });
    }

    const item = {
      id: crypto.randomUUID(),
      jid,
      messageId: raw?.key?.id || null,
      createdAt: new Date().toISOString(),
      input: text.slice(0, 2000),
      suggestion: generated.text,
      status: 'pending',
      provider: generated.provider,
      model: generated.model,
      risk,
      memoryMessages: crm.getMessages(jid, { limit: 12 }).messages.length
    };

    state.suggestions[jid] ||= [];
    state.suggestions[jid].push(item);
    audit({
      type: risk.sensitive ? 'suggestion_handoff_required' : 'suggestion_created',
      jid,
      suggestionId: item.id,
      messageId: item.messageId,
      mode: current.mode,
      provider: item.provider,
      risk
    });

    if (current.mode === 'automatic') {
      if (risk.sensitive) {
        audit({
          type: 'automatic_blocked_sensitive',
          jid,
          suggestionId: item.id,
          reasons: risk.reasons
        });
      } else if (!automaticAllowed) {
        audit({
          type: 'automatic_blocked_gate',
          jid,
          suggestionId: item.id
        });
      } else {
        await sendText(jid, item.suggestion);
        item.status = 'auto_sent';
        item.reviewedAt = new Date().toISOString();
        audit({
          type: 'automatic_sent',
          jid,
          suggestionId: item.id
        });
      }
    }

    save();
    return item;
  };

  return {
    status,
    setMode,
    listSuggestions,
    reviewSuggestion,
    listAudit,
    handleIncoming,
    classifySensitivity,
    providerStatus
  };
}
