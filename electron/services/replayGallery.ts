import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clipName } from '../../src/utils/replayNames';
import { Readable } from 'node:stream';
import type { DriveListing, ReplayClip, ReplayFolder } from '../../src/types/studio';
import { validClipId } from './replay';

/**
 * Avisos para as páginas abertas (SSE): replay novo, enviado ao Drive, renomeado, movido ou apagado.
 * A página recarrega a lista na hora (e ainda confere sozinha de tempos em tempos, se o aviso não chegar).
 */
export class GalleryEvents {
  private clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= 50) {
      res.writeHead(429).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  /** Algo mudou: avisa todas as páginas (vários avisos seguidos viram um só). */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const res of this.clients) res.write('data: mudou\n\n');
    }, 300);
  }

  get count(): number {
    return this.clients.size;
  }
}

/** O que a página precisa da pasta de replays (a ReplayStore do Estúdio). */
export interface GallerySource {
  list(): Promise<ReplayClip[]>;
  folders(): Promise<ReplayFolder[]>;
  path(id: string): string;
  /** Nome do projeto (título da página). */
  project?: () => Promise<string>;
  /** Avisos de mudança para as páginas abertas. */
  events?: GalleryEvents;
  /** Pasta do projeto no Google Drive (null = Drive não conectado). */
  drive?: {
    list(): Promise<DriveListing | null>;
    stream(fileId: string, range: string | undefined): Promise<Response>;
  };
}

export interface GalleryItem {
  id: string;
  name: string;
  folder: string | null;
  createdAt: number;
  seconds: number;
  bytes: number;
  note: string;
  /** Trecho que vai ao ar (corte feito no Estúdio), em segundos. */
  start: number;
  end: number | null;
}

/** Lista para a página: pastas (na ordem do Estúdio) e replays, do mais novo para o mais antigo. */
export async function galleryList(source: GallerySource): Promise<{ project: string; folders: { id: string; name: string }[]; clips: GalleryItem[] }> {
  const [clips, folders, project] = await Promise.all([source.list(), source.folders(), source.project?.() ?? Promise.resolve('')]);
  return {
    project,
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    clips: clips.map((c) => ({ id: c.id, name: clipName(clips, c.id), folder: c.folder ?? null, createdAt: c.createdAt, seconds: c.seconds, bytes: c.bytes, note: c.note ?? '', start: c.start ?? 0, end: c.end ?? null })),
  };
}

/** Nome do arquivo baixado (só caracteres seguros para o cabeçalho). */
const downloadName = (name: string, id: string) => {
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'replay';
  return { ascii: `${ascii}.mp4`, utf8: encodeURIComponent(`${name.slice(0, 100)}.mp4`), fallback: id };
};

/**
 * Rotas da página dos replays (depois de /r/<link secreto>/):
 *   (vazio)          página
 *   app.js           script da página
 *   lista            JSON com pastas e replays
 *   v/<arquivo>      vídeo (com Range: dá para avançar e voltar); ?baixar=1 baixa o arquivo
 */
export async function handleGallery(source: GallerySource, rest: string[], url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (rest.length === 0) {
    // Sem a barra no fim, "app.js" e "lista" seriam procurados fora do link secreto (página ficava em "Carregando…").
    if (!url.pathname.endsWith('/')) {
      res.writeHead(302, { Location: `${url.pathname}/`, 'Cache-Control': 'no-store' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; img-src 'self' data:",
    });
    res.end(GALLERY_HTML);
    return;
  }
  if (rest[0] === 'app.js' && rest.length === 1) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(GALLERY_SCRIPT);
    return;
  }
  if (rest[0] === 'lista' && rest.length === 1) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(await galleryList(source)));
    return;
  }
  if (rest[0] === 'eventos' && rest.length === 1 && source.events) {
    source.events.subscribe(req, res);
    return;
  }
  if (rest[0] === 'drive' && rest.length === 1) {
    let body: unknown;
    try {
      const listing = source.drive ? await source.drive.list() : null;
      body = listing ? { available: true, ...listing } : { available: false, error: null };
    } catch (e) {
      body = { available: false, error: e instanceof Error ? e.message : String(e) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  if (rest[0] === 'd' && rest.length === 2 && /^[\w-]{10,128}$/.test(rest[1]) && source.drive) {
    // Vídeo do Drive passando pelo Estúdio (funciona mesmo com a pasta só para a conta conectada).
    const upstream = await source.drive.stream(rest[1], typeof req.headers.range === 'string' ? req.headers.range : undefined);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status === 416 ? 416 : 404).end();
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': upstream.headers.get('content-type') ?? 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    const wanted = url.searchParams.get('nome');
    if (url.searchParams.get('baixar') === '1') {
      const n = downloadName(wanted?.slice(0, 120) || 'replay', rest[1]);
      headers['Content-Disposition'] = `attachment; filename="${n.ascii}"; filename*=UTF-8''${n.utf8}`;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD') {
      res.end();
      void upstream.body.cancel().catch(() => undefined);
      return;
    }
    const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  if (rest[0] === 'v' && rest.length === 2 && validClipId(rest[1])) {
    const id = rest[1];
    const file = source.path(id);
    const info = await stat(file).catch(() => null);
    if (!info) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    if (url.searchParams.get('baixar') === '1') {
      const clips = await source.list();
      const n = downloadName(clipName(clips, id), id);
      headers['Content-Disposition'] = `attachment; filename="${n.ascii}"; filename*=UTF-8''${n.utf8}`;
    }
    const size = info.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': String(size) });
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  res.writeHead(404).end();
}

const GALLERY_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Replays · Estúdio ao Vivo</title>
<style>
  :root { color-scheme: dark; --bg: #0b0c0e; --panel: #15171b; --line: #2a2d33; --text: #f1f2f4; --muted: #9aa0a8; --accent: #f5a524; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: rgba(11, 12, 14, .92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
  header h1 { margin: 0; font-size: 18px; }
  header .count { color: var(--muted); font-size: 13px; }
  header input { margin-left: auto; width: min(260px, 45vw); padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; font-size: 14px; }
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
  .note { font-size: 13px; color: #d7dade; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  .actions a { flex: 1; text-align: center; padding: 8px; border-radius: 6px; background: var(--accent); color: #111; font-weight: 700; font-size: 13px; text-decoration: none; }
  .source { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }
  .error { color: #ff8a8a; text-align: center; padding: 16px; }
</style>
</head>
<body>
<header><h1 id="titulo">Replays</h1><span class="count" id="count"></span><input id="busca" type="search" placeholder="Buscar" aria-label="Buscar replays"></header>
<main id="lista"><p class="empty">Carregando…</p></main>
<script src="app.js"></script>
</body>
</html>`;

/** Script da página (arquivo próprio: a política de segurança não aceita script dentro do HTML). */
const GALLERY_SCRIPT = `(() => {
  const base = location.pathname.replace(/\\/+$/, '');
  const list = document.getElementById('lista');
  const count = document.getElementById('count');
  const search = document.getElementById('busca');
  const title = document.getElementById('titulo');
  // Mostra a pasta do projeto no Google Drive; sem Drive conectado, os replays deste computador.
  let view = null;
  let shown = '';
  const open = new Set(['__sem__']);
  // Cartões e grupos já na tela: reaproveitados ao atualizar (um vídeo tocando não para quando chega outro).
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
  const sigOf = (it) => JSON.stringify([it.name, it.src, it.download, it.note, it.seconds, it.bytes, it.cut]);
  const cardFor = (it) => {
    const sig = sigOf(it);
    const cached = cards.get(it.key);
    if (cached && cached.sig === sig) return cached.el;
    const fresh = card(it);
    fresh.dataset.novo = cached ? '' : '1';
    cards.set(it.key, { sig, el: fresh });
    return fresh;
  };
  /** Troca os filhos só se mudaram (mover um vídeo tocando no mesmo instante não o interrompe). */
  const setChildren = (parent, kids) => {
    const now = [...parent.children];
    if (now.length === kids.length && now.every((n, i) => n === kids[i])) return;
    parent.replaceChildren(...kids);
  };
  const card = (it) => {
    const video = el('video', { controls: '', preload: 'metadata', playsinline: '', src: it.src });
    const meta = [when(it.createdAt), secs(it.seconds) + (it.cut ? ' (cortado)' : ''), size(it.bytes)].filter(Boolean).join(' · ');
    return el('article', { class: 'clip' }, video, el('div', { class: 'info' },
      el('span', { class: 'name' }, it.name),
      el('span', { class: 'meta' }, meta),
      ...(it.note ? [el('span', { class: 'note' }, it.note)] : []),
      el('div', { class: 'actions' }, el('a', { href: it.download, download: '' }, 'Baixar'))));
  };
  const fromDrive = (d) => ({
    project: d.project, url: d.url, source: 'Pasta do projeto no Google Drive',
    groups: d.groups.map((g) => ({ id: g.name === null ? '__sem__' : 'g:' + g.name, name: g.name, items: g.videos.map((v) => ({
      key: v.id, name: v.name, createdAt: v.createdAt, seconds: v.seconds, bytes: v.bytes, note: '', cut: false,
      src: base + '/d/' + encodeURIComponent(v.id) + '#t=0.1',
      download: base + '/d/' + encodeURIComponent(v.id) + '?baixar=1&nome=' + encodeURIComponent(v.name),
    })) })),
  });
  const fromLocal = (data, error) => ({
    project: data.project, url: null, source: (error ? 'Google Drive indisponível (' + error + '): ' : 'Google Drive não conectado: ') + 'replays deste computador',
    groups: [...data.folders.map((f) => ({ id: f.id, name: f.name })), { id: '__sem__', name: null }].map((g) => ({ id: g.id, name: g.name, items: data.clips.filter((c) => (c.folder ?? '__sem__') === g.id).map((c) => {
      const src = base + '/v/' + encodeURIComponent(c.id);
      const cut = c.start > 0 || c.end !== null;
      return { key: c.id, name: c.name, createdAt: c.createdAt, seconds: Math.max(0, (c.end ?? c.seconds) - c.start), bytes: c.bytes, note: c.note, cut,
        src: src + (cut ? '#t=' + c.start + (c.end !== null ? ',' + c.end : '') : '#t=0.1'), download: src + '?baixar=1' };
    }) })),
  });
  const sourceEl = el('p', { class: 'source' });
  const emptyEl = el('p', { class: 'empty' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const total = view.groups.reduce((n, g) => n + g.items.length, 0);
    count.textContent = total + (total === 1 ? ' vídeo' : ' vídeos');
    if (view.project) { title.textContent = 'Replays · ' + view.project; document.title = 'Replays · ' + view.project; }
    const groups = view.groups.map((g) => ({ ...g, items: g.items.filter((it) => !q || (it.name + ' ' + it.note).toLowerCase().includes(q)) }));
    const key = JSON.stringify([q, view.source, groups.map((g) => [g.id, g.name, g.items.map(sigOf), g.items.map((it) => it.key)])]);
    if (key === shown) return;
    shown = key;
    sourceEl.textContent = view.source;
    const kids = [sourceEl];
    if (total === 0 || groups.every((g) => g.items.length === 0)) {
      emptyEl.textContent = total === 0 ? 'Nenhum vídeo ainda.' : 'Nenhum vídeo encontrado.';
      kids.push(emptyEl);
    }
    const named = groups.some((g) => g.name !== null && g.items.length);
    const alive = new Set();
    for (const g of groups) {
      if (g.items.length === 0) continue;
      const label = g.name ?? (named ? 'Fora de pasta' : 'Todos os vídeos');
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
      box.summary.replaceChildren(label, el('small', null, g.items.length + (g.items.length === 1 ? ' vídeo' : ' vídeos')));
      if (q) box.d.open = true;
      const els = g.items.map((it) => { alive.add(it.key); return cardFor(it); });
      setChildren(box.grid, els);
      kids.push(box.d);
    }
    for (const k of [...cards.keys()]) if (!alive.has(k)) cards.delete(k);
    setChildren(list, kids);
  };
  const load = async () => {
    try {
      const d = await fetch(base + '/drive', { cache: 'no-store' }).then((r) => { if (r.status === 404) throw new Error('Link inválido ou trocado. Peça o link novo ao operador.'); return r.json(); });
      let next;
      if (d.available) next = fromDrive(d);
      else {
        const res = await fetch(base + '/lista', { cache: 'no-store' });
        if (!res.ok) throw new Error('Erro ' + res.status);
        next = fromLocal(await res.json(), d.error);
      }
      view = next;
      render();
    } catch (e) {
      if (!view) list.replaceChildren(el('p', { class: 'error' }, String(e.message || e)));
    }
  };
  search.addEventListener('input', () => view && render());
  // Atualização na hora: o Estúdio avisa quando sai replay novo (ou muda algum); a cada 10 s confere de novo.
  let loading = null;
  let again = false;
  const refresh = () => {
    if (loading) { again = true; return; }
    loading = load().finally(() => { loading = null; if (again) { again = false; refresh(); } });
  };
  try {
    const events = new EventSource(base + '/eventos');
    events.onmessage = refresh;
    events.onopen = refresh;
  } catch (e) { /* sem avisos: fica a conferência periódica */ }
  refresh();
  setInterval(refresh, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();`;
