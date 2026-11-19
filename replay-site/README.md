# Página pública dos replays — replay.maisbasquete.com.br

Site pequeno (Node 20, sem dependências) que mostra os replays enviados pelo Estúdio ao Vivo ao Google Drive.
Abre na transmissão mais recente; no topo dá para escolher as anteriores. Fica no ar mesmo com o Mac desligado.

## Configuração (uma vez)

1. **Google Drive** — na pasta principal dos replays (padrão "Estúdio ao Vivo · Replays"):
   Compartilhar › Acesso geral › **Qualquer pessoa com o link** (Leitor). Copie o id da pasta: o trecho depois de
   `/folders/` no endereço.
2. **Google Cloud** (mesmo projeto do login do Drive/YouTube) — APIs e serviços › Credenciais › Criar credenciais ›
   **Chave de API**. Restrinja a chave à **Google Drive API**. Ela só lê o que é público.
3. **Easypanel** — novo serviço *App* (ex.: `replay`):
   - Origem: GitHub `sandrorod/mbtransmissao`, branch `main`, **Build Path `/replay-site`**, construção Nixpacks.
   - Ambiente: `DRIVE_FOLDER_ID=<id da pasta>` e `GOOGLE_API_KEY=<chave>`.
   - Domínio: `replay.maisbasquete.com.br`, HTTPS ligado, porta **80**.
4. **Cloudflare** (maisbasquete.com.br) — DNS: `CNAME replay → <endereço .easypanel.host do serviço>`, nuvem
   **cinza** (DNS only), para o Easypanel emitir o certificado.

## Rotas

| Rota | O quê |
|---|---|
| `/` | página |
| `/projetos` | transmissões (pastas dentro da pasta principal), mais recente primeiro |
| `/drive?p=<id>` | pastas e vídeos de uma transmissão (sem `p`: a mais recente). A página aceita `/?p=<id>` |
| `/d/<id>` | vídeo (com Range); `?baixar=1&nome=…` baixa. Só vídeos das pastas listadas |
| `/saude` | verificação |

O Drive é consultado no máximo a cada 10 s (cache), não a cada visitante.

Teste local: `DRIVE_FOLDER_ID=… GOOGLE_API_KEY=… PORT=8080 node server.mjs`.
