// Página pública dos replays (replay.maisbasquete.com.br).
//
// Lê a pasta "Estúdio ao Vivo · Replays" do Google Drive — para onde o Estúdio envia cada replay sozinho — e mostra
// a transmissão mais recente (ou outra escolhida no topo), agrupada pelas pastas da área Replay. Fica no ar mesmo
// com o Mac desligado. Sem dependências: Node 20+ (fetch nativo).
//
// Variáveis de ambiente:
//   DRIVE_FOLDER_ID   id da pasta principal no Drive (compartilhada como "Qualquer pessoa com o link: leitor")
//   GOOGLE_API_KEY    chave de API do Google Cloud com a Google Drive API ativada (só lê arquivos públicos)
//   PORT              porta (padrão 80)
import http from 'node:http';
import { Readable } from 'node:stream';

const ROOT = process.env.DRIVE_FOLDER_ID ?? '';
const KEY = process.env.GOOGLE_API_KEY ?? '';
const PORT = Number(process.env.PORT || 80);
const API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3'; // DRIVE_API_BASE: só para testes
const FOLDER = 'application/vnd.google-apps.folder';
const ID_RE = /^[\w-]{10,128}$/;
const CACHE_MS = 10_000;

if (!ROOT || !KEY) console.warn('[replay-site] Falta DRIVE_FOLDER_ID e/ou GOOGLE_API_KEY: a página vai mostrar o erro.');

/** Arquivos de uma pasta (só o que é público: a chave de API não enxerga o resto). */
async function children(parent, order = 'createdTime desc') {
  if (!ROOT || !KEY) throw new Error('Site sem configuração: falta DRIVE_FOLDER_ID e/ou GOOGLE_API_KEY no Easypanel.');
  const q = `'${parent}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q,
    key: KEY,
    orderBy: order,
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    fields: 'files(id,name,mimeType,size,createdTime,videoMediaMetadata(durationMillis))',
  });
  const res = await fetch(`${API}/files?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (/API key not valid|API_KEY_INVALID/i.test(detail)) throw new Error('Chave do Google (GOOGLE_API_KEY) inválida.');
    if (/has not been used|SERVICE_DISABLED|accessNotConfigured/i.test(detail)) throw new Error('A Google Drive API está desativada no projeto da chave: ative em APIs e serviços › Biblioteca › Google Drive API.');
    if (res.status === 404 || res.status === 403) throw new Error(`Pasta do Drive sem acesso público (${res.status}). Compartilhe a pasta como "Qualquer pessoa com o link".`);
    throw new Error(`Google Drive ${res.status}: ${detail}`);
  }
  return (await res.json()).files ?? [];
}

const isVideo = (f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('video/');
// O Google recusa (403) o download de vídeo pedido do servidor (IP de datacenter) com chave de API, mas aceita
// quando é o navegador de quem assiste que pede: a página toca e baixa direto do Drive, sem passar por aqui.
// A chave aparece na página: ela só lê arquivos públicos e deve ficar restrita à Google Drive API.
const mediaUrl = (id) => `${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(KEY)}`;
const downloadUrl = (id) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
const video = (f) => ({
  id: f.id,
  src: mediaUrl(f.id),
  download: downloadUrl(f.id),
  name: f.name.replace(/\.(mp4|mov|m4v|webm)$/i, ''),
  bytes: Number(f.size ?? 0),
  createdAt: f.createdTime ? Date.parse(f.createdTime) : 0,
  seconds: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null,
});

// ─── Cache (o Drive é consultado no máximo a cada 10 s, não a cada visitante) ───────────────────────────────
let projectsCache = { at: 0, value: null };
const listingCache = new Map(); // projectId -> { at, value }
/** Vídeos que podem passar pelo servidor: só os das pastas listadas (não vira passagem para qualquer arquivo). */
const knownVideos = new Set();

async function projects() {
  if (projectsCache.value && Date.now() - projectsCache.at < CACHE_MS) return projectsCache.value;
  const value = (await children(ROOT)).filter((f) => f.mimeType === FOLDER).map((f) => ({ id: f.id, name: f.name, createdAt: Date.parse(f.createdTime ?? '') || 0 }));
  projectsCache = { at: Date.now(), value };
  return value;
}

async function listing(projectId) {
  const cached = listingCache.get(projectId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const list = await projects();
  const project = list.find((p) => p.id === projectId);
  if (!project) return null;
  const top = await children(project.id);
  const groups = [];
  for (const folder of top.filter((f) => f.mimeType === FOLDER).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
    groups.push({ name: folder.name, videos: (await children(folder.id)).filter(isVideo).map(video) });
  }
  groups.push({ name: null, videos: top.filter(isVideo).map(video) });
  for (const g of groups) for (const v of g.videos) knownVideos.add(v.id);
  const value = { project: project.name, projectId: project.id, groups };
  listingCache.set(projectId, { at: Date.now(), value });
  return value;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────────────────────────────────────
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const json = (res, status, body) => {
  res.writeHead(status, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const downloadName = (name) => ({
  ascii: `${name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'replay'}.mp4`,
  utf8: encodeURIComponent(`${name.slice(0, 100)}.mp4`),
});

async function streamVideo(req, res, url, id) {
  if (!knownVideos.has(id)) {
    // Recarrega as listagens recentes antes de recusar (vídeo novo que ainda não estava no cache)
    try {
      const list = await projects();
      for (const p of list.slice(0, 3)) {
        listingCache.delete(p.id);
        await listing(p.id);
      }
    } catch {
      /* segue para o 404 */
    }
    if (!knownVideos.has(id)) return void res.writeHead(404, { ...SECURITY, 'X-Motivo': 'video-fora-da-pasta' }).end();
  }
  const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
  const upstream = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(KEY)}`, {
    headers: range ? { Range: range } : {},
  });
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    console.error(`[replay-site] Drive recusou o vídeo ${id}: ${upstream.status} ${detail}`);
    return void res.writeHead(upstream.status === 416 ? 416 : 404, { ...SECURITY, 'X-Motivo': `drive-${upstream.status}` }).end();
  }
  const headers = { ...SECURITY, 'Content-Type': upstream.headers.get('content-type') ?? 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  if (url.searchParams.get('baixar') === '1') {
    const n = downloadName(url.searchParams.get('nome')?.slice(0, 120) || 'replay');
    headers['Content-Disposition'] = `attachment; filename="${n.ascii}"; filename*=UTF-8''${n.utf8}`;
  }
  res.writeHead(upstream.status, headers);
  if (req.method === 'HEAD') {
    res.end();
    void upstream.body.cancel().catch(() => undefined);
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, SECURITY).end();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        ...SECURITY,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' https://www.googleapis.com; img-src 'self' data:",
      });
      return void res.end(HTML);
    }
    if (path === '/app.js') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return void res.end(SCRIPT);
    }
    if (path === '/saude') return json(res, 200, { ok: true });
    if (path === '/projetos') {
      const list = await projects();
      return json(res, 200, { projects: list.map(({ id, name, createdAt }) => ({ id, name, createdAt })) });
    }
    if (path === '/drive') {
      let list = await projects();
      const wanted = url.searchParams.get('p') ?? url.searchParams.get('projeto');
      // Transmissão nova (pasta acabou de ser criada pelo Estúdio): busca a lista de novo em vez de esperar o cache
      if (wanted && ID_RE.test(wanted) && !list.some((p) => p.id === wanted) && Date.now() - projectsCache.at > 2000) {
        projectsCache = { at: 0, value: null };
        list = await projects();
      }
      const id = wanted && ID_RE.test(wanted) && list.some((p) => p.id === wanted) ? wanted : list[0]?.id;
      if (!id) return json(res, 200, { available: true, project: '', projectId: null, groups: [] });
      return json(res, 200, { available: true, ...(await listing(id)) });
    }
    const m = /^\/d\/([\w-]{10,128})$/.exec(path);
    if (m) return void (await streamVideo(req, res, url, m[1]));
    res.writeHead(404, SECURITY).end();
  } catch (e) {
    console.error('[replay-site]', e);
    if (res.headersSent) return void res.destroy();
    // 200 com o motivo: o proxy do Easypanel troca respostas 5xx por uma página genérica dele (o motivo sumia)
    json(res, 200, { available: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => console.log(`[replay-site] na porta ${PORT}`));

// ─── Página ─────────────────────────────────────────────────────────────────────────────────────────────────
const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replays · Mais Basquete</title>
<style>
  :root { color-scheme: dark; --bg: #0b0c0e; --panel: #15171b; --line: #2a2d33; --text: #f1f2f4; --muted: #9aa0a8; --accent: #f5a524; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 14px 16px; background: rgba(11, 12, 14, .92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
  header h1 { margin: 0; font-size: 18px; }
  header .count { color: var(--muted); font-size: 13px; }
  header .tools { margin-left: auto; display: flex; gap: 8px; min-width: 0; }
  header select, header input { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; font-size: 14px; }
  header select { max-width: min(260px, 45vw); }
  header input { width: min(220px, 40vw); }
  main { max-width: 1200px; margin: 0 auto; padding: 12px 16px 40px; }
  details { margin: 0 0 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  summary { display: flex; align-items: center; gap: 8px; padding: 12px 14px; cursor: pointer; font-weight: 700; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: "▸"; color: var(--accent); transition: transform .15s; }
  details[open] summary::before { transform: rotate(90deg); }
  summary small { color: var(--muted); font-weight: 400; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; padding: 0 12px 12px; }
  .clip { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #0f1114; }
  .clip[data-novo="1"] { animation: novo 2.5s ease-out; }
  @keyframes novo { from { box-shadow: 0 0 0 3px var(--accent); } to { box-shadow: 0 0 0 0 transparent; } }
  .clip video { width: 100%; aspect-ratio: 16 / 9; background: #000; display: block; }
  .info { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
  .name { font-weight: 700; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12.5px; }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  .actions a { flex: 1; text-align: center; padding: 8px; border-radius: 6px; background: var(--accent); color: #111; font-weight: 700; font-size: 13px; text-decoration: none; }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }
  .error { color: #ff8a8a; text-align: center; padding: 16px; }
  @media (max-width: 560px) { header .tools { margin-left: 0; width: 100%; } header select, header input { flex: 1; max-width: none; width: auto; } }
</style>
</head>
<body>
<header><h1 id="titulo">Replays</h1><span class="count" id="count"></span>
<span class="tools"><select id="projeto" aria-label="Transmissão" hidden></select><input id="busca" type="search" placeholder="Buscar" aria-label="Buscar replays"></span></header>
<main id="lista"><p class="empty">Carregando…</p></main>
<script src="app.js"></script>
</body>
</html>`;

const SCRIPT = `(() => {
  const list = document.getElementById('lista');
  const count = document.getElementById('count');
  const search = document.getElementById('busca');
  const title = document.getElementById('titulo');
  const picker = document.getElementById('projeto');
  // Transmissão escolhida (na URL: dá para mandar o link de uma transmissão antiga); vazio = a mais recente.
  const params = new URLSearchParams(location.search);
  let chosen = params.get('p') || params.get('projeto') || '';
  let view = null;
  let shown = '';
  const open = new Set(['__sem__']);
  const cards = new Map();
  const groupsEl = new Map();
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) e.setAttribute(k, v);
    for (const k of kids) e.append(k);
    return e;
  };
  const size = (b) => !b ? '' : b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const when = (ms) => ms ? new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const secs = (s) => s === null || s === undefined ? '' : s.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' s';
  const sigOf = (it) => JSON.stringify([it.name, it.src, it.seconds, it.bytes]);
  const card = (it) => {
    const video = el('video', { controls: '', preload: 'metadata', playsinline: '', src: it.src });
    const meta = [when(it.createdAt), secs(it.seconds), size(it.bytes)].filter(Boolean).join(' · ');
    return el('article', { class: 'clip' }, video, el('div', { class: 'info' },
      el('span', { class: 'name' }, it.name),
      el('span', { class: 'meta' }, meta),
      el('div', { class: 'actions' }, el('a', { href: it.download, target: '_blank', rel: 'noopener' }, 'Baixar'))));
  };
  const cardFor = (it) => {
    const sig = sigOf(it);
    const cached = cards.get(it.key);
    if (cached && cached.sig === sig) return cached.el;
    const fresh = card(it);
    fresh.dataset.novo = cached || !view ? '' : '1';
    cards.set(it.key, { sig, el: fresh });
    return fresh;
  };
  const setChildren = (parent, kids) => {
    const now = [...parent.children];
    if (now.length === kids.length && now.every((n, i) => n === kids[i])) return;
    parent.replaceChildren(...kids);
  };
  const fromDrive = (d) => ({
    project: d.project, projectId: d.projectId,
    groups: d.groups.map((g) => ({ id: g.name === null ? '__sem__' : 'g:' + g.name, name: g.name, items: g.videos.map((v) => ({
      key: v.id, name: v.name, createdAt: v.createdAt, seconds: v.seconds, bytes: v.bytes,
      src: (v.src || '/d/' + encodeURIComponent(v.id)) + '#t=0.1',
      download: v.download || '/d/' + encodeURIComponent(v.id) + '?baixar=1&nome=' + encodeURIComponent(v.name),
    })) })),
  });
  const emptyEl = el('p', { class: 'empty' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const total = view.groups.reduce((n, g) => n + g.items.length, 0);
    count.textContent = total + (total === 1 ? ' vídeo' : ' vídeos');
    title.textContent = view.project ? 'Replays · ' + view.project : 'Replays';
    document.title = (view.project ? 'Replays · ' + view.project : 'Replays') + ' · Mais Basquete';
    const groups = view.groups.map((g) => ({ ...g, items: g.items.filter((it) => !q || it.name.toLowerCase().includes(q)) }));
    const key = JSON.stringify([q, view.projectId, groups.map((g) => [g.id, g.name, g.items.map(sigOf), g.items.map((it) => it.key)])]);
    if (key === shown) return;
    shown = key;
    const kids = [];
    if (total === 0 || groups.every((g) => g.items.length === 0)) {
      emptyEl.textContent = total === 0 ? 'Nenhum replay ainda.' : 'Nenhum replay encontrado.';
      kids.push(emptyEl);
    }
    const named = groups.some((g) => g.name !== null && g.items.length);
    const alive = new Set();
    for (const g of groups) {
      if (g.items.length === 0) continue;
      const label = g.name ?? (named ? 'Fora de pasta' : 'Todos os replays');
      let box = groupsEl.get(g.id);
      if (!box) {
        const summary = el('summary');
        const grid = el('div', { class: 'grid' });
        const d = el('details', { 'data-id': g.id }, summary, grid);
        d.open = open.has(g.id) || !named;
        d.addEventListener('toggle', () => { if (d.open) open.add(g.id); else open.delete(g.id); });
        box = { d, summary, grid };
        groupsEl.set(g.id, box);
      }
      box.summary.replaceChildren(label, el('small', null, ' ' + g.items.length + (g.items.length === 1 ? ' vídeo' : ' vídeos')));
      if (q) box.d.open = true;
      const els = g.items.map((it) => { alive.add(it.key); return cardFor(it); });
      setChildren(box.grid, els);
      kids.push(box.d);
    }
    for (const k of [...cards.keys()]) if (!alive.has(k)) cards.delete(k);
    setChildren(list, kids);
  };
  const loadProjects = async () => {
    const r = await fetch('/projetos', { cache: 'no-store' });
    if (!r.ok) return;
    const { projects } = await r.json();
    picker.hidden = projects.length < 2;
    const opts = projects.map((p, i) => el('option', { value: i === 0 ? '' : p.id }, p.name + (i === 0 ? ' (mais recente)' : '')));
    picker.replaceChildren(...opts);
    picker.value = projects.some((p, i) => i > 0 && p.id === chosen) ? chosen : '';
  };
  const load = async () => {
    try {
      const r = await fetch('/drive' + (chosen ? '?p=' + encodeURIComponent(chosen) : ''), { cache: 'no-store' });
      const d = await r.json();
      if (!d.available) throw new Error(d.error || 'Replays indisponíveis no momento.');
      const next = fromDrive(d);
      if (view && view.projectId !== next.projectId) { cards.clear(); groupsEl.clear(); shown = ''; }
      view = next;
      render();
    } catch (e) {
      if (!view) list.replaceChildren(el('p', { class: 'error' }, String(e.message || e)));
    }
  };
  picker.addEventListener('change', () => {
    chosen = picker.value;
    const u = new URL(location.href);
    u.searchParams.delete('projeto');
    if (chosen) u.searchParams.set('p', chosen); else u.searchParams.delete('p');
    history.replaceState(null, '', u);
    view = null; cards.clear(); groupsEl.clear(); shown = '';
    list.replaceChildren(el('p', { class: 'empty' }, 'Carregando…'));
    refresh();
  });
  search.addEventListener('input', () => view && render());
  let loading = null;
  let again = false;
  const refresh = () => {
    if (loading) { again = true; return; }
    loading = load().finally(() => { loading = null; if (again) { again = false; refresh(); } });
  };
  loadProjects().catch(() => undefined);
  refresh();
  // Replay novo aparece sozinho (o Estúdio envia ao Drive depois de cada corte)
  setInterval(refresh, 10000);
  setInterval(() => loadProjects().catch(() => undefined), 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();`;
