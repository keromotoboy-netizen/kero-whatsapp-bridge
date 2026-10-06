# Kero CRM — P0

## Implementado no Bridge
- [x] Conversas em tempo real e resposta pelo CRM
- [x] Aba Arquivados e eventos de etiquetas
- [x] Fotos de perfil sob demanda
- [x] Preservar mensagem recebida após "apagar para todos" + aviso
- [x] Enviar imagem, arquivo e áudio/voz
- [x] Exibir localização recebida
- [x] Online / digitando / gravando / visto por último quando disponível
- [x] Resolver LID → número com precedência PN e deduplicação de chats
- [x] Sincronizar histórico de grupos/arquivados e resync de app-state
- [x] Paginar histórico sem o antigo corte fixo de 500 mensagens por chat
- [x] Atualizar localização ao vivo via messages.update
- [x] Expor metadados/thumbnail de mídias recebidas
- [x] Corrigir idempotência de unread e impedir regressão de lastMessageTimestamp

## IA de atendimento
- [x] Modos Desligada / Sugestões / Automática
- [x] Memória curta por conversa
- [x] Base de regras da Kero Motoboy
- [x] Handoff obrigatório em casos sensíveis
- [x] Criar sugestão antes de qualquer envio automático
- [x] Auditoria persistente de cada decisão/resposta
- [x] Provider FREE-MAX: regras determinísticas sempre disponíveis
- [x] Suporte opcional a Ollama local/gratuito
- [x] Gate de envio automático desligado por padrão

## Provas automatizadas
- [x] Replay de histórico não duplica unread
- [x] Histórico antigo não faz lastMessageTimestamp regredir
- [x] LID + PN viram um chat canônico
- [x] Paginação testada acima de 500 mensagens
- [x] Atualização de localização viva testada
- [x] Preview de mídia testado
- [x] Handoff sensível testado
- [x] Automático bloqueado quando sensível
- [x] CI: node --check + node --test

## Ainda exige validação de produção
Os itens acima são implementação/código. Antes de declarar o CRM 100% em produção ainda é obrigatório validar, com a conta autorizada:
1. histórico inicial real de uma conversa longa;
2. LID tardio real;
3. arquivar/desarquivar no WhatsApp e refletir no CRM;
4. uma localização ao vivo real durante atualização;
5. mídias reais (imagem, vídeo, áudio, documento);
6. modo Sugestões;
7. modo Automática apenas com gate explicitamente habilitado;
8. rollback do deploy.
