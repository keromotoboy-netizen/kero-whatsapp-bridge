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

## Envio já existente — não alterado

`POST /crm/send` com `{ "jid": "...", "text": "..." }`.

Resposta de sucesso da rota atual: `{ "ok": true, "messageId": string|null, "resolved": boolean }`, HTTP 200. Isso comprova apenas retorno de `sock.sendMessage` pela biblioteca, **não** confirmação do servidor, entrega ou leitura. Falha de conexão retorna 409; outras falhas 502; corpo inválido 400. Se `messageId` vier nulo, tratar referência como não recuperável/UNKNOWN e **não** disparar novamente cegamente.

**Integração Frente 3:** o runner candidato que procura `response.key.id` precisa adaptar-se ao `response.messageId` realmente emitido pelo Bridge. Não alterar o runner nesta frente.

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

31 testes sintéticos locais passaram: 14 exclusão, 14 favoritamento e 3 CRM-store/recuperação. Incluem chave errada, mensagem de terceiros, grupo errado, timeout, falha de disco, reinício, duplicação, exclusão local e recibo durável. Nenhum teste acessou a sessão real do WhatsApp.

**Pendente:** homologação de eventos reais Baileys e ACK individual em janela controlada; validação de recebimento dos eventos pelo Bridge em Railway; conciliação das frentes 1/3/4; deploy seguro só após resolver patch staged destrutivo, volume, backups, locks e autorizações. Sem operação real de WhatsApp sem autorização individual.

## Rollback

Reverter somente o commit `f634aed33500684c694b9ebe5fea0ad6205f3a56` da branch candidata depois de confirmar HEAD e lock; base recuperável `2393105e6ecf23903e9186665f9e33d047e8bf70`. Backups locais no CINZA: `C:\Users\ailla\KeroAudits\bridge-group-actions-20261104\*.backup-frente2-20261104` e `test\*.backup-frente2-20261104`. Como **nenhum deploy foi executado**, não há rollback de produção nesta etapa.
