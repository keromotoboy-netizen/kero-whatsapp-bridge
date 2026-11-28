# Producao (Railway whatsapp-bridge) - 28/11/2026

Esta branch (`production-live-20261128`) contem o codigo REAL que roda no Railway (servico `whatsapp-bridge`, deploy de 28/11/2026),
extraido do servidor por `railway ssh` e conferido por sha256. A `master` e a `production/whatsapp-bridge` estao DESATUALIZADAS: nao subir a partir delas.

Mudancas de 28/11 sobre o codigo anterior (server.mjs):
- log sem linhas de sessao do libsignal; "reenvio negado" logado uma vez por mensagem;
- mapa chat oculto (@lid) -> numero a partir de remoteJidAlt/participantAlt; resolucao sob demanda e a cada 20 min;
- rota `GET /crm/inbox?since=<epoch>&limit=` com as respostas novas de todos os chats (com `pn` resolvido).

Deploy: `railway up --service whatsapp-bridge --detach` a partir de uma pasta com estes arquivos. Rollback: deploy anterior 83592fa6. Volume /data/auth guarda a sessao do WhatsApp: nunca apagar.
Healthcheck: `GET /health` (aberta).
