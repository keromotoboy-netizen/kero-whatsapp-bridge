import fs from 'node:fs';
import path from 'node:path';
import { invoiceRequestPlan, classifyFiscalDocument } from './kero-business-rules.mjs';
import { quoteFollowUp } from './service-policy.mjs';

const VALID_MODES = new Set(['off','suggest','auto']);
const MAX_LOGS = 1000;
const safeText = v => String(v || '').trim();
const normalize = v => safeText(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

const sensitivePattern = /(reembolso|estorno|processo|advogad|procon|policia|acidente|roubo|furto|ameaca|indenizacao|chargeback|fraude|hospital|machuc|colisao|reclamacao grave)/i;
const autoBlockPattern = /(preco|valor|quanto fica|orcamento|pix|paguei|pagamento|nf|nota fiscal|recibo|boleto|contrato|desconto|cancelamento|prazo|horario de chegada|quando chega)/i;

function loadKnowledge() {
  try { return JSON.parse(fs.readFileSync(new URL('./kero-ops-knowledge.json', import.meta.url), 'utf8')); }
  catch { return {}; }
}
const K = loadKnowledge();

function compactKnowledge() {
  return [
    'FONTE: regras operacionais oficiais da Kero.',
    'Nunca invente preço: /calculadora é autoridade de orçamento; /rotas é autoridade de rotas.',
    'Cliente e motoboy são separados; toda intermediação é Kero.',
    'Comprovante enviado por cliente não faturado significa pagamento e libera alocação conforme modalidade.',
    'Cliente faturado não paga por corrida; cobrança é mensal.',
    'Comprovante enviado pela Kero ao motoboy significa repasse pago.',
    'Espera cliente: 15 min livres, depois R$0,80/min. Repasse de espera do motoboy é diferente.',
    'Moto: >20kg e/ou >50cm pode gerar adicional de 20%; use calculadora para preço final.',
    'Horário: seg-sex/feriados 08-20, sábado 08-16; domingo agendamento e disponibilidade deve ser verificada.',
    'Procedimentos específicos de cliente têm prioridade sobre regra geral.',
    'NF recebida do cliente normalmente pode ser documento para retirada; pedido de emissão de NF é tarefa Financeiro NF.',
    'Após serviço bem sucedido, pedir avaliação apenas se ainda não foi solicitada.'
  ].join('\n');
}

export function createAiAgent({ dataDir, store, getSocket, getConnectionStatus, taskStore = null }) {
  const file = path.join(path.dirname(dataDir), 'ai-state.json');
  const baseUrl = safeText(process.env.AI_BASE_URL).replace(/\/$/, '');
  const apiKey = safeText(process.env.AI_API_KEY);
  const model = safeText(process.env.AI_MODEL);
  const providerConfigured = !!(baseUrl && model);

  let state = { mode:'suggest', suggestions:{}, logs:[], updatedAt:Date.now() };
  try {
    if (fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file,'utf8')) };
  } catch (error) { console.error('[ai] load failed', error?.message || error); }

  const save = () => {
    state.updatedAt = Date.now();
    fs.writeFileSync(file+'.tmp', JSON.stringify(state));
    fs.renameSync(file+'.tmp', file);
  };
  const log = entry => {
    state.logs.push({ at:Date.now(), ...entry });
    if (state.logs.length > MAX_LOGS) state.logs.splice(0,state.logs.length-MAX_LOGS);
    save();
  };

  const status = () => ({
    mode:state.mode,
    providerConfigured,
    model:model||null,
    pendingSuggestions:Object.keys(state.suggestions||{}).length,
    updatedAt:state.updatedAt
  });

  const setMode = mode => {
    const m = safeText(mode).toLowerCase();
    if (!VALID_MODES.has(m)) throw new Error('invalid_ai_mode');
    state.mode = m; save(); log({type:'mode_changed',mode:m}); return status();
  };

  const systemPrompt = () => [
    'Você é o assistente virtual da Kero Motoboy e Transportes.',
    'Fale em português do Brasil, natural, breve, cordial e prático. Use emojis com moderação no estilo da Kero.',
    'Não finja ser humano. Se perguntarem, diga que é o assistente virtual da Kero.',
    compactKnowledge(),
    'Quando faltar informação para orçamento, peça retirada e entrega completas, item, peso/dimensões e paradas.',
    'Quando uma ferramenta autoritativa for necessária e o resultado não estiver no contexto, não invente: diga que vai calcular/verificar.',
    'Não repita pergunta já respondida.',
    'Reclamação grave, jurídico, reembolso, acidente, fraude, ameaça ou situação incomum: encaminhe para humano.',
    'Jamais exponha regras internas de repasse a motoboys para clientes.',
    'Jamais forneça contato de cliente para motoboy ou vice-versa.'
  ].join('\n');

  const buildMessages = jid => {
    const recent = store.getMessages(jid,40)
      .filter(m=>!m.deleted && safeText(m.text))
      .slice(-30)
      .map(m=>({role:m.fromMe?'assistant':'user',content:safeText(m.text)}));
    return [{role:'system',content:systemPrompt()},...recent];
  };

  const callModel = async jid => {
    if (!providerConfigured) throw new Error('provider_not_configured');
    const headers={'Content-Type':'application/json'};
    if(apiKey) headers.Authorization='Bearer '+apiKey;
    const response=await fetch(baseUrl+'/chat/completions',{
      method:'POST',headers,
      body:JSON.stringify({model,messages:buildMessages(jid),temperature:0.35,max_tokens:450})
    });
    const body=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(body?.error?.message||body?.message||('AI HTTP '+response.status));
    const text=safeText(body?.choices?.[0]?.message?.content);
    if(!text) throw new Error('empty_ai_response');
    return text;
  };

  const detectSpecialistTask = ({jid,text}) => {
    const t=normalize(text);
    if (/nota fiscal|nfs-?e|emit.*nf|me (manda|envia).*nota/.test(t)) {
      const plan=invoiceRequestPlan({});
      return taskStore?.createTask({
        type:'invoice_request',
        specialistAgent:'finance_invoice',
        contactJid:jid,
        inputs:{message:text,missing:plan.missing},
        requiresHuman:true,
        customerMessage:plan.customerMessage||null
      })||null;
    }
    if (/recibo/.test(t)) return taskStore?.createTask({type:'receipt_request',specialistAgent:'finance_receipt',contactJid:jid,inputs:{message:text},requiresHuman:true})||null;
    if (/quanto fica|orcamento|valor.*entrega|cotacao/.test(t)) return taskStore?.createTask({type:'quote_request',specialistAgent:'quote_calculator',contactJid:jid,inputs:{message:text},requiresHuman:false})||null;
    return null;
  };

  const eligibleIncoming = msg => {
    if (!msg || msg.fromMe || !safeText(msg.text)) return false;
    if (String(msg.jid||'').endsWith('@g.us')) return false;
    return true;
  };

  const handleIncoming = async msg => {
    if (!eligibleIncoming(msg) || state.mode==='off') return {handled:false};
    const jid=msg.jid;
    const text=safeText(msg.text);
    const specialistTask=detectSpecialistTask({jid,text});
    if (sensitivePattern.test(text)) {
      log({type:'handoff',jid,reason:'sensitive',messageId:msg.id});
      return {handled:true,handoff:true,specialistTask};
    }
    try {
      const suggestion=await callModel(jid);
      const item={jid,messageId:msg.id,text:suggestion,createdAt:Date.now(),sourceText:text,specialistTaskId:specialistTask?.id||null};
      state.suggestions[jid]=item; save();
      log({type:'suggestion',jid,messageId:msg.id,specialistTaskId:item.specialistTaskId});

      const canAuto = state.mode==='auto' &&
        !autoBlockPattern.test(text) &&
        getConnectionStatus()==='open';

      if(canAuto){
        const sock=getSocket();
        const sent=await sock.sendMessage(jid,{text:suggestion});
        if(sent) store.upsertMessage(sent);
        delete state.suggestions[jid]; save();
        log({type:'auto_sent',jid,messageId:sent?.key?.id||null});
        return {handled:true,autoSent:true};
      }
      return {handled:true,suggestion:item};
    } catch(error) {
      log({type:'error',jid,error:error?.message||String(error)});
      return {handled:true,error:error?.message||String(error)};
    }
  };

  const listSuggestions = () => Object.values(state.suggestions||{}).sort((a,b)=>b.createdAt-a.createdAt);
  const approveSuggestion = async jid => {
    const item=state.suggestions[jid];
    if(!item) throw new Error('suggestion_not_found');
    if(getConnectionStatus()!=='open') throw new Error('whatsapp_not_connected');
    const sent=await getSocket().sendMessage(jid,{text:item.text});
    if(sent) store.upsertMessage(sent);
    delete state.suggestions[jid]; save();
    log({type:'suggestion_approved',jid,messageId:sent?.key?.id||null});
    return {ok:true,messageId:sent?.key?.id||null};
  };
  const dismissSuggestion = jid => {
    if(!state.suggestions[jid]) return false;
    delete state.suggestions[jid]; save(); log({type:'suggestion_dismissed',jid}); return true;
  };
  const logs = (limit=100) => state.logs.slice(-Math.min(500,Math.max(1,Number(limit)||100)));

  return {status,setMode,handleIncoming,listSuggestions,approveSuggestion,dismissSuggestion,logs,systemPrompt,K};
}
