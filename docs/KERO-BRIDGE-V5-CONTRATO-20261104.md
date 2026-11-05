# KERO — WhatsApp Bridge / Despacho V5 — contrato candidato

**Frente:** 2 · **Estado:** PARCIAL, preparado e testado sem WhatsApp real · **Data:** 2026-11-04

**Escopo:** somente favoritamento individual, exclusão de mensagem própria e status de confirmações. **Não altera** o botão manual Disparar, IA comercial, fotos, reações ou áudio. Não é autorização para enviar mensagens. A branch deste documento permanece **draft e fora de produção**.

## Fonte e versão

- Repositório: `keromotoboy-netizen/kero-whatsapp-bridge`.
- Base verificada: `2393105e6ecf23903e9186665f9e33d047e8bf70`.
- Correção testada: `f634aed33500684c694b9ebe5fea0ad6205f3a56` (primeira rodada); segunda rodada: correção de UNKNOWN e bloqueio de star após delete.
- Railway ativo na verificação: `d33a82f9-1aa5-45e5-87bb-b1403bf7b547`, commit `4ccfa3d4c7a43e326886e1617106d1c085e2ed1c`; a correção deste PR não está publicada.
- **Nunca** aceitar o patch Railway staged `0be4ae3c-1c10-4c0d-9f2f-8ea1b8418a2a`: inclui `whatsapp-auth-storage` em `staged-delete`. Preservar `/data/auth`.

## Autenticação e chave individual

As rotas usam o middleware existente `secure`, não interpretação de comandos de IA. Favoritar/excluir/status exigem JSON com `jid` (JID de grupo terminado em `@g.us`) e `id` (messageId **real** obtido após envio). A chave lógica é `(jid,id)`, e a mensagem precisa constar no histórico local como `fromMe === true`. Nunca reconstruir `id` a partir de hash. Não converter HTTP 200 em prova de entrega.

## Envio: somente grupos alterados na branch candidata

`POST /crm/send` com `{ "jid": "...", "text": "..." }`.

Em grupos, após `sock.sendMessage`, a branch valida `sent.key.remoteJid === targetJid`, `fromMe===true`, `messageId` válido e a existência do registro no CRM. Só devolve HTTP 200 com `{ok:true,messageId,resolved,receiptPersisted:true}` **após `CRM.saveNow(true)` concluir**. Isso prova gravação síncrona local da referência, não ACK definitivo do servidor, entrega, leitura ou fsync contra perda de energia. Em timeout, referência inválida ou falha de gravação *depois do efeito externo possível*, devolve HTTP 202 com `{ok:false,outcome:"UNKNOWN",retry:false,messageId:string|null,error:"..."}`; nunca disparar novamente automaticamente. Regras de validação anteriores, incluindo HTTP 400 e 409, continuam. Mensagens privadas mantêm o comportamento anterior.

**Integração Frente 3:** o runner da Frente 3 no PR #10 já reconhece `response.messageId` do Bridge. Em HTTP 202/`ok:false`, deve marcar `UNKNOWN` e não executar retry. Não alterar o runner nesta frente.

## Favoritamento — 1 mensagem por chamada

`POST /crm/star` com `{ "jid": "...", "id": "..." }`.

`POST /crm/star-status` com o mesmo corpo. Consulta sem mutação externa.

Formato do status, tanto na resposta da ação quanto na consulta:

```json
{
  "ok": true,
  "operation": "star",
  "requested": true,
  "accepted": true,
  "starred": false,
  "confirmed": false,
  "outcome": "PENDING",
  "confirmationSource": null
}
```

- `requested`: reserva local registrada **antes** da chamada externa.
- `accepted`: o `chatModify` resolveu; não significa favoritamento confirmado.
- `confirmed=true` e `starred=true`: apenas após evento de estado `messages.update` com `starred:true`, guardado de forma síncrona; `confirmationSource="messages.update:starred"`.
- `outcome`: `NOT_REQUESTED`, `PENDING`, `UNKNOWN` (timeout/resultado ambíguo) ou `CONFIRMED`.
- HTTP 202 = pendente/desconhecido; não repetir a operação. HTTP 200 da ação somente quando há recibo confirmado; HTTP 200 da consulta **não** muda o `confirmed`.
- HTTP 502 = resultado incerto, **sem retry automático**; 503 = falha na reserva persistente (ação não efetuada); 409 = offline/mensagem apagada; 400 = chave malformada; 404 = mensagem própria não localizada.
- Repetição da mesma chave devolve `duplicateSuppressed:true` sem nova chamada externa.
- Após `deleteRequestedAt`, novas solicitações `/crm/star` são bloqueadas com HTTP 409 e `noAction:true`.
- Um favorito observado sem gravação durável é `UNKNOWN`, não `PENDING`.

## Exclusão para todos — 1 mensagem própria por chamada

`POST /crm/delete` com `{ "jid": "...", "id": "..." }`.

`POST /crm/delete-status` com o mesmo corpo. Consulta sem mutação externa.

Status análogo, mas com `operation:"delete"` e `deleted` em vez de `starred`:

```json
{
  "ok": true,
  "operation": "delete",
  "requested": true,
  "accepted": true,
  "deleted": false,
  "confirmed": false,
  "outcome": "PENDING",
  "confirmationSource": null
}
```

- A biblioteca envia `sock.sendMessage(jid, { delete: { remoteJid:jid, id, fromMe:true, participant? } })`.
- `accepted=true` significa que o comando retornou da biblioteca, não que a mensagem sumiu para todos.
- Apenas um evento `messages.update` do tipo **REVOKE** observado e persistido marca `deletedForEveryone` e `deleteReceiptDurable`; só então `deleted=true`, `confirmed=true`, `outcome="CONFIRMED"` e `confirmationSource="messages.update:REVOKE"`.
- `messages.delete` isoladamente indica remoção local; **não prova exclusão para todos**.
- HTTP 202 = pendente/ambíguo e nenhuma nova exclusão automática; HTTP 200 da ação só com evidência durável; HTTP 502 = resultado incerto, não repetir; demais erros 400/404/409/503 conforme validação e disponibilidade.
- Mesmo após restart ou timeout, as reservas existentes impedem uma segunda chamada para a mesma chave.
- Revogação observada sem recibo durável é `UNKNOWN`, não `PENDING`.
- Mensagens já excluídas localmente sem recibo de revogação retornam 409, sem efeito externo.

## Níveis de confirmação — não confundir

1. **Envio aceito pela biblioteca:** resposta de `/crm/send`, normalmente com `messageId`.
2. **ACK do servidor:** campo numérico `deliveryStatus >= 1` recebido assincronamente do WhatsApp, se houver; não faz parte da resposta `/crm/send`.
3. **Entrega:** `deliveryStatus >= 2`, se houver evento; não inferir a partir de HTTP 200.
4. **Favorito confirmado:** evento de `starred:true` observado e persistido (sem prova E2E em produção).
5. **Exclusão confirmada:** evento REVOKE observado e persistido (sem prova E2E em produção).
6. **UNKNOWN:** resultado incerto após mutação externa; travar retries até conciliação manual da mesma referência.

## Testes e limites de homologação

53 testes locais/sintéticos passaram: 14 exclusão, 14 favoritamento, 3 CRM-store/recuperação, 8 testes pareados F4 em sombra e 14 testes de envio por grupo. Incluem chave errada, mensagem de terceiros, grupo errado, timeout, falha de disco, reinício, duplicação, exclusão local e recibo durável. Nenhum teste acessou a sessão real do WhatsApp.

**Pendente:** homologação de eventos reais Baileys e ACK individual em janela controlada; validação de recebimento dos eventos pelo Bridge em Railway; conciliação das frentes 1/3/4; deploy seguro só após resolver patch staged destrutivo, volume, backups, locks e autorizações. Sem operação real de WhatsApp sem autorização individual.

## Rollback

Reverter somente o commit `f634aed33500684c694b9ebe5fea0ad6205f3a56` da branch candidata depois de confirmar HEAD e lock; base recuperável `2393105e6ecf23903e9186665f9e33d047e8bf70`. Backups locais no CINZA: `C:\Users\ailla\KeroAudits\bridge-group-actions-20261104\*.backup-frente2-20261104` e `test\*.backup-frente2-20261104`. Como **nenhum deploy foi executado**, não há rollback de produção nesta etapa.


## Extensão para Frente 4 — sombra pareada (04/11/2026)

**Aviso:** FRENTE 2 — BRIDGE V5 — RECIBOS E EXCLUSÃO PAREADA LIBERADOS PARA INTEGRAÇÃO EM SOMBRA. É somente liberação de testes sintéticos e adaptação de contratos, não liberação de execução no WhatsApp nem homologação produtiva.

Código: `crm-group-star.mjs`, `crm-group-delete.mjs`, `test/crm-group-paired-shadow.test.mjs` e `test/crm-group-send-receipt-shadow.test.mjs`. Ambos endpoints de ação exigem o par literal `{jid,id}` de mensagem própria previamente conhecida. Respostas autenticadas retornam `messageRef:{jid,id}`, exclusivamente no canal privado de runtime; JID/messageId nunca entram em log, D1 compartilhado, handoff ou callback Xiaomi.

**Máquina de estados exata:**
- `NOT_REQUESTED`: nenhuma reserva existente.
- `IN_FLIGHT`: reserva gravada e chamada Baileys atualmente em andamento neste processo. Nunca reexecute a chamada.
- `PENDING`: retorno da biblioteca registrado duravelmente, sem evento conclusivo. `accepted:true` não prova entrega, estrela ou revogação.
- `UNKNOWN`: timeout, resultado incerto, recibo não durável ou reserva após reinício sem ACK recuperável. Bloqueia nova tentativa automaticamente.
- `CONFIRMED`: exclusivamente atualização individual de estrela `messages.update:starred` ou evento `messages.update:REVOKE` persistido no CRM para o mesmo `jid+id`.

`/crm/star-status` e `/crm/delete-status` são consultas POST com auth, sem ações externas. HTTP 200 nessas consultas significa apenas resposta HTTP, **não** confirmação. O campo `outcome` e o par `messageRef` são obrigatórios na decisão de integração. HTTP 202 pode retornar `IN_FLIGHT`, `PENDING` ou `UNKNOWN` e sempre proíbe retry.

**Entrada F3/F4 preservada:** `KERO-SG-EVENT-V1`; saída F3 `KERO-F3-SG-SHADOW-V1`; callback lógico `SG_SHADOW_OBSERVATION`. Os recibos F2 são evidência interna para adaptadores confiáveis do servidor, nunca permissões do Xiaomi. Em qualquer ação sombra: `effects:0`, `canExecute:false`, `retry:false`. Não criar outro canal de WhatsApp, fila, executor ou novo gateway. F4 pode ampliar testes sintéticos de leitura sem chamar rotas reais nem alterar `sg-robo.js`/`sg-jogar.js`.

**Recibo individual de envio:** a função existente `sendCrmText` produz `{ok:true,messageId,resolved}`, e a associação a grupo ocorre na chave `sent.key.remoteJid` recebida da biblioteca. Foram testados pares por grupo, IDs iguais em grupos distintos, ID ausente e timeout, sem enviar mensagens reais. Na branch candidata, o envio para grupos exige `CRM.saveNow(true)` concluído antes de retornar `ok:true`, e um teste de armazenamento real comprovou a recuperação após reinício simulado. **Não há garantia de recuperar ID se o processo morrer antes de receber o ACK ou se faltar fsync perante falha de energia.** Os demais caminhos privados permanecem inalterados. Não declarar recuperabilidade integral de O.S., não repetir envios incertos, não ativar exclusão real.

**Escopo e evidências:** 43/43 testes sintéticos aprovados (0 falhas) no CINZA; HEAD desta etapa é o commit de correção posterior a `e41a9ca`. Repositório continua PR #30 draft. Nenhum merge/deploy; produção Railway ainda no commit `4ccfa3d4`; patch staged `0be4ae3c` continua destrutivo para `whatsapp-auth-storage`, jamais aceitar. Necessários para AVISO 2: confirmação real do fluxo WhatsApp e garantia de persistência imediata de recibo de envio, identidade atestada, autoridade da fila/política, licença explícita para alvos reais, backup e rollback.


## Terceira rodada — persistência síncrona do recibo após ACK (05/11 UTC)

Código `server.mjs`: gravação estrita com `CRM.saveNow(true)` apenas para `@g.us`, comparação do par `targetJid + sent.key.id` e `fromMe:true`, verificação local do registro antes da resposta. Em caso de retorno do socket sem ID válido, erro de rede, chave de grupo divergente ou falha pós-ACK de persistência: `HTTP 202`, `ok:false`, `outcome:"UNKNOWN"`, `retry:false`. Não confundir `receiptPersisted:true` com ACK do servidor, entrega ou revogação.

Testes novos/atualizados em `test/crm-group-send-receipt-shadow.test.mjs` e `test/crm-group-send-durable-store.test.mjs`, incluindo disco real temporário, JSON recuperável após reinício, falha de gravação e compatibilidade de envio privado. Total da suíte específica: **53/53 aprovados, 0 falhas**, somente locais; nenhum WhatsApp real. Proteções F3/F4, `effects:0`, `canExecute:false` e `retry:false` preservadas. Produção bloqueada pelo staged-delete de volume Railway e ausência de E2E autorizado. Para rollback da terceira rodada, reverter somente o commit que introduz `saveNow(true)` no `server.mjs`, com backup no CINZA `server.mjs.backup-f2-postack-20261104`.


## Quarta rodada — reserva opcional pré-envio por operação da Frente 3

**Candidato, sem deploy nem ativação na Frente 3.** O endpoint existente `POST /crm/send` aceita opcionalmente `dispatchKey` (identificador opaco estável, 8–128 caracteres `[A-Za-z0-9_.:-]`), além de `jid` e `text`. Sem `dispatchKey` a rota continua com o comportamento anterior; o caminho de mensagens privadas não usa reservas de grupos. A Frente 3 precisa passar a **mesma chave por comando autorizado** (ex.: `commandId` canônico), para todos os grupos alvo; o Bridge compõe internamente a chave `SHA256(JSON.stringify([targetJid,dispatchKey]))`. Não usar hash de texto como identidade da O.S.; não criar fila nem nova automação.

Antes da chamada externa, o Bridge grava `groupSendReservations[hash]` no estado local com `phase:"RESERVED"`, hora e resumo SHA-256 do texto, usando `CRM.saveNow(true)`. Falha da reserva: `ok:false,outcome:"UNKNOWN",retry:false,error:"group_dispatch_reservation_not_durable"` e nenhum envio. Após `sock.sendMessage`, valida grupo + `messageId` real + `fromMe:true`, grava mensagem e atualiza reserva para `PERSISTED` com `messageId` no mesmo `saveNow(true)` antes de responder `ok:true,receiptPersisted:true`. Caso o envio seja incerto ou a persistência falhe, a reserva impede novo efeito com o mesmo `dispatchKey`.

Chamadas repetidas com mesma chave e mesmo texto: se o recibo está persistido e a mensagem própria continua disponível, retorna o mesmo `messageId`, `duplicateSuppressed:true` e **nenhuma nova chamada** ao socket; se a reserva estiver órfã/resultado for incerto, retorna `ok:false,outcome:"UNKNOWN",retry:false,duplicateSuppressed:true`. Mesma chave e texto diferente retorna erro `group_dispatch_key_conflict` sem ação; a rota devolve HTTP 202 para UNKNOWN. `dispatchKey` inválido também não causa efeito.

**Regras para F3:** incluir `dispatchKey` apenas se tiver comando registrado na fila `compute_jobs`, identidade autorizada e fence válido. Não derivar de timestamps, texto, grupo ou ID de mensagem gerado. Reutilizar a chave original na conciliação sem jamais reexecutar a O.S. em `UNKNOWN`. O código atual do PR10 `createManualCommandRunner` envia apenas `{jid,text}`: a proteção é opcional/inativa para esse consumidor até adaptação autorizada pelo dono F3.

**Limitações:** reserva local não demonstra exclusividade de múltiplos processos ou servidores, nem fsync contra perda total de energia. O armazenamento cresce por comando e ainda exige política de retenção coordenada; NÃO apagar o histórico necessário para recuperação. Ainda não há garantias de idempotência de ponta a ponta do WhatsApp, especialmente se o cliente mudar `dispatchKey`. Favoritos e exclusão seguem o contrato separado e sem retries cegos.

**Evidências:** 63/63 testes sintéticos Node PASS / 0 FAIL no CINZA, incluindo reserva antes do envio, falha de disco, perda de ACK, concorrência, isolamento por grupo, replay com mesmo ID após restart e testes com CRM real em arquivos temporários. Não houve envio, exclusão ou deploy real. A liberação permanece **somente sombra**, não AVISO 2. Rollback desta rodada: reverter apenas o commit posterior a `50d38ea`, backup local `server.mjs.backup-f2-presend-idempotency-20261104`.
