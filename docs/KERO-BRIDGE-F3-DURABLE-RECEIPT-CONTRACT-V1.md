# KERO — F2 Bridge ↔ F3 Despacho | Contrato de recibos duráveis V1

**Fonte:** Bridge PR #30, HEAD-base `c9adadd32435d20708529219434dbe6580e6929b` (draft); F3 PR #10, último HEAD observado `230ba04293a2ece011deae8bc7dde859ce68c7c1`. Data: 2026-11-05. **Estado: CONTRATO CANDIDATO PARA SOMBRA, NÃO IMPLANTADO.**

## Endpoints e confirmação

| Rota | Solicitação | Confirmação válida |
|---|---|---|
| `POST /crm/send` (grupo) | `{jid,text,dispatchKey}` | **HTTP 200**, `ok:true`, `receiptPersisted:true`, `messageId` real e vinculado ao mesmo `jid`; significa apenas **recibo local**, não entrega |
| `POST /crm/star` | `{jid,id}` | `outcome:CONFIRMED`, `confirmed:true`, evento `messages.update:starred` persistido |
| `POST /crm/star-status` | `{jid,id}` | Consulta passiva, não gera novo efeito |
| `POST /crm/delete` | `{jid,id}` | `outcome:CONFIRMED`, `confirmed:true`, evento `messages.update:REVOKE` persistido |
| `POST /crm/delete-status` | `{jid,id}` | Consulta passiva, não gera novo efeito |

`requested` = solicitação/reserva registrada; `accepted` = biblioteca retornou; `IN_FLIGHT` = efeito externo ainda incerto; `PENDING` = falta confirmação específica; `UNKNOWN` = possível efeito sem prova; `CONFIRMED` requer recibo/evidência durável apropriado à operação. HTTP 200/202 isolado não comprova entrega, favoritamento ou revogação. Nenhum estado incerto permite retry cego.

## Idempotência e `dispatchKey`

F3 deve fornecer o **mesmo ID canônico persistido do comando autorizado** (`commandId`) como `dispatchKey`, estável após reinício, retry de transporte e perda de ACK, reutilizado para todos os grupos do mesmo comando. Para cada grupo, F2 deriva reserva separada com `SHA256(JSON.stringify([jid,dispatchKey]))` e grava `RESERVED` com `CRM.saveNow(true)` **antes** de chamar o socket. Depois de receber o `messageId` real da própria mensagem no grupo exato, F2 grava o recibo e `PERSISTED` antes do HTTP 200.

- Mesma chave/grupo/texto com recibo persistido: devolver o mesmo ID e `duplicateSuppressed:true`, sem envio.
- Reserva anterior sem recibo confirmado: `HTTP 202,ok:false,outcome:UNKNOWN,retry:false`, sem novo efeito.
- Mesma chave/grupo com texto diferente: conflito, sem novo efeito. Grupos diferentes têm estados e IDs independentes.
- Chave opcional **omitida** mantém comportamento legado **sem proteção pré-envio**. Formato admitido: 8–128 caracteres alfanuméricos, `_`, `.`, `:`, `-`. Nunca derivar do texto, timestamp ou ID aleatório por tentativa.

## Regra obrigatória do consumidor F3

Para um **envio de grupo** o recibo **local** só pode ser classificado `CONFIRMED` com a expressão:

```js
httpStatus === 200 &&
body?.ok === true &&
body?.receiptPersisted === true &&
typeof body?.messageId === "string" &&
body.messageId.trim().length >= 8
```

Isso **não** equivale à entrega do WhatsApp. Em `HTTP 200` sem `receiptPersisted:true`, `HTTP 202`, timeout, erro, ACK perdido ou resposta incompleta: `UNKNOWN` (ou estado PENDING comprovado) e `retry:false`. Persistir resultado sob o fence original; não reenviar O.S. antigas/incertas.

**Lacuna F3 observada no PR #10:** `app/kero-panel-manual-runner-v5.mjs` ainda envia somente `{jid,text}` e pode classificar `ok:true + messageId` como `CONFIRMED` sem exigir `receiptPersisted:true`. Correção exclusiva da Frente 3/Claude. Não alterar aqui.

## Cancelamento não é exclusão

Cancelar a O.S. muda o estado do pedido e impede novas ações; **não** produz `/crm/delete` automaticamente. Excluir a mensagem precisa de comando **separado e autorizado**, `jid` e `messageId` reais da mensagem própria e confirmação específica REVOKE persistida. `messages.delete` sozinho não comprova revogação.

## Gate de QA, desvio HTTP e pendências

- Testes novos: `test/crm-f3-receipt-contract.test.mjs` (8 cenários Node offline, sem WhatsApp).
- Pact Provider contra Bridge isolado: 3 contratos legados aprovados, mas precisam de contratos negativos adicionais.
- Toxiproxy: ACK/HTTP retardado e replay suprimido; k6: 8 chamadas localhost, 2 trabalhadores.
- Schemathesis: devolução `HTTP 202/UNKNOWN` para `dispatchKey` inválida é **segura contra efeito**, mas viola o OpenAPI estrito que espera HTTP 4xx. O limite experimental de 45 caracteres do texto não consta do Bridge; não o elevar a regra sem decisão.
- Testes não provam fsync, perda total de energia, multi-instância nem sessão real. npm audit do Lote 5 reportou 3 alertas moderados; OSV encontrou 1 `minimatch`. Stryker na cópia QA falhou por junction `bin` (`EPERM`); não declarar mutação aprovada.
- Patch Railway `0be4ae3c-1c10-4c0d-9f2f-8ea1b8418a2a` ameaça `whatsapp-auth-storage`. **Proibido aplicar**, reiniciar ou reconectar.

**Feature flag proposta, NÃO implantada:** `F3_BRIDGE_STRICT_DURABLE_RECEIPT_V1`, default OFF; a Frente 3 ativa apenas após integrar `dispatchKey`, validar `receiptPersisted`, passar Pact/regressão e coordenar publicação com Claude/Victor. Não criar fila, robô, scheduler ou executor alternativo.

**Aceite para sombra:** HEAD verificado e teste do código exato, nova suíte 8/8 PASS, regressões/Pact afetados PASS, nenhuma operação real, handoff e rollback disponíveis. **Aceite produtivo separado:** publicação autorizada pela coordenação, preservação de volume, locks, backup e verificação de eventos reais sob autorização específica.

**Rollback deste lote:** reverter apenas o commit que adiciona esta documentação e seu teste (nenhuma mudança funcional). Não fazer rollback em produção: não houve deploy.
