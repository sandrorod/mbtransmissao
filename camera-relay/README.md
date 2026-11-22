# Ponte dos celulares no domínio próprio — camera.maisbasquete.com.br

Serviço pequeno (Node 20, sem dependências) que dá aos celulares um **link fixo** no seu domínio, com certificado de
verdade (o celular não mostra o aviso de "conexão não particular"). Serve para celulares em **outra rede** (4G, outro
Wi‑Fi). O Mac não precisa abrir porta no roteador: o próprio Estúdio se liga ao servidor e busca os pedidos.

Só passam as mensagens de conexão (pequenas). **O vídeo não passa pelo servidor**: vai direto do celular para o Mac
(WebRTC). Em 4G, se o celular conectar mas ficar "Sem vídeo", configure um TURN em Conectar celular › Retransmissão.

## Configuração (uma vez)

1. **Easypanel** — novo serviço *App* (ex.: `camera`):
   - Origem: GitHub `sandrorod/mbtransmissao`, branch `main`, **Build Path `/camera-relay`**, construção Nixpacks.
   - Ambiente: `RELAY_SECRET=<uma senha longa, 16+ caracteres>` (ex.: gere com `openssl rand -base64 24`).
   - Domínio: `camera.maisbasquete.com.br`, HTTPS ligado, porta **80**.
2. **Cloudflare** (maisbasquete.com.br) — DNS: `CNAME camera → <endereço .easypanel.host do serviço>`, nuvem
   **cinza** (DNS only), para o Easypanel emitir o certificado.
3. **Estúdio** — Conectar celular › **Meu servidor (domínio próprio)**: endereço `https://camera.maisbasquete.com.br`
   e a mesma chave do `RELAY_SECRET` › Salvar. Em "Link para outra rede por", escolha **Meu servidor** e ligue
   "Celular em outra rede".

A chave fica só no computador do Estúdio, cifrada pelo Keychain.

## Rotas

| Rota | O quê |
|---|---|
| `/c/<código>` e `/celular.js` | página do celular (repassada ao Estúdio) |
| `/c/<código>/espera`, `/enviar`, `/ice` | mensagens da conexão (repassadas ao Estúdio) |
| `/_estudio/espera`, `/_estudio/resposta` | o Estúdio busca pedidos e responde (exige `x-estudio-chave`) |
| `/saude` | verificação (mostra se o Estúdio está ligado) |

Teste local: `RELAY_SECRET=chave-de-teste-123456 PORT=8080 node server.mjs`.
