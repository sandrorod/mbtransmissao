// Ponte dos celulares no domínio próprio (ex.: camera.maisbasquete.com.br).
//
// O celular abre https://camera.seudominio/c/<código>; este servidor não guarda nada: repassa cada pedido do celular
// ao Estúdio (que fica "pendurado" aqui buscando pedidos, então funciona com o Mac atrás de qualquer roteador, sem
// abrir porta) e devolve a resposta do Estúdio ao celular. Só passam as mensagens de conexão (pequenas): o vídeo vai
// direto do celular para o Mac pelo WebRTC (ou pelo TURN, se configurado no Estúdio).
//
// Diferente do túnel rápido da Cloudflare: o endereço é sempre o mesmo e o certificado é de verdade (o celular não
// mostra aviso de "conexão não particular").
//
// Sem dependências: Node 20+.
// Variáveis de ambiente:
//   RELAY_SECRET   chave combinada com o Estúdio (Conectar celular › Meu servidor). Obrigatória, mínimo 16 caracteres.
//   PORT           porta (padrão 80)
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.RELAY_SECRET ?? '';
const PORT = Number(process.env.PORT || 80);
/** O Estúdio busca pedidos e a busca fica aberta até chegar algum (ou este tempo). */
const STUDIO_WAIT_MS = 25_000;
/** O celular espera a resposta do Estúdio até este tempo (a consulta longa do celular dura 20 s no Estúdio). */
const PHONE_WAIT_MS = 40_000;
/** Sem o Estúdio buscar por este tempo, ele conta como desligado. */
const STUDIO_GONE_MS = 35_000;
const MAX_BODY = 64 * 1024;
const MAX_PENDING = 300;

if (SECRET.length < 16) console.warn('[camera-relay] RELAY_SECRET ausente ou curta (mínimo 16 caracteres): o Estúdio não conseguirá se ligar.');

/** Pedidos de celulares esperando o Estúdio buscar. */
const queue = [];
/** Pedidos já entregues ao Estúdio, esperando a resposta: id → { res, timer }. */
const pending = new Map();
/** Buscas do Estúdio abertas agora. */
let studioWaiters = [];
let studioSeen = 0;

function secretOk(value) {
  if (SECRET.length < 16 || typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

function page(res, status, title, text) {
  res.writeHead(status, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title><body style="font-family:-apple-system,sans-serif;background:#0b0c0e;color:#f1f2f4;padding:24px;line-height:1.45"><h2>${title}</h2><p>${text}</p>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Entrega os pedidos da fila a uma busca do Estúdio que esteja aberta. */
function flush() {
  while (queue.length && studioWaiters.length) {
    const waiter = studioWaiters.shift();
    clearTimeout(waiter.timer);
    const jobs = queue.splice(0, 50);
    waiter.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    waiter.res.end(JSON.stringify(jobs));
  }
}

const studioOnline = () => studioWaiters.length > 0 || Date.now() - studioSeen < STUDIO_GONE_MS;

async function fromPhone(req, res, url) {
  if (!studioOnline()) {
    page(res, 503, 'Estúdio desligado', 'O computador do Estúdio não está ligado a este endereço agora. Peça ao operador para abrir “Conectar celular” e ligar “Celular em outra rede”.');
    return;
  }
  if (queue.length + pending.size >= MAX_PENDING) {
    res.writeHead(503, security).end();
    return;
  }
  let body = '';
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch { res.writeHead(413, security).end(); return; }
  }
  const id = randomUUID();
  const job = { id, method: req.method, path: url.pathname + url.search, type: req.headers['content-type'] ?? '', body };
  const timer = setTimeout(() => {
    pending.delete(id);
    const at = queue.findIndex((j) => j.id === id);
    if (at >= 0) queue.splice(at, 1);
    if (!res.headersSent) res.writeHead(504, security).end();
  }, PHONE_WAIT_MS);
  pending.set(id, { res, timer });
  // Celular desistiu (fechou a página): o pedido sai da fila.
  res.on('close', () => {
    if (!pending.has(id)) return;
    clearTimeout(timer);
    pending.delete(id);
    const at = queue.findIndex((j) => j.id === id);
    if (at >= 0) queue.splice(at, 1);
  });
  queue.push(job);
  flush();
}

function studioPoll(req, res, url) {
  studioSeen = Date.now();
  // Primeira busca ("ola"): responde na hora, para o Estúdio saber logo que está ligado e que a chave confere.
  if (url.searchParams.has('ola') && queue.length === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('[]');
    return;
  }
  const waiter = { res, timer: null };
  waiter.timer = setTimeout(() => {
    studioWaiters = studioWaiters.filter((w) => w !== waiter);
    studioSeen = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('[]');
  }, STUDIO_WAIT_MS);
  res.on('close', () => {
    clearTimeout(waiter.timer);
    studioWaiters = studioWaiters.filter((w) => w !== waiter);
  });
  studioWaiters.push(waiter);
  flush();
}

async function studioAnswer(req, res) {
  studioSeen = Date.now();
  let answer;
  try { answer = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end(); return; }
  const list = Array.isArray(answer) ? answer : [answer];
  for (const a of list) {
    const item = a && typeof a.id === 'string' ? pending.get(a.id) : undefined;
    if (!item) continue;
    clearTimeout(item.timer);
    pending.delete(a.id);
    const status = Number.isInteger(a.status) && a.status >= 100 && a.status < 600 ? a.status : 502;
    const headers = { ...security, 'Cache-Control': 'no-store' };
    if (typeof a.type === 'string' && a.type) headers['Content-Type'] = a.type;
    if (typeof a.csp === 'string' && a.csp) headers['Content-Security-Policy'] = a.csp;
    if (!item.res.headersSent) item.res.writeHead(status, headers).end(typeof a.body === 'string' ? a.body : '');
  }
  res.writeHead(204).end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/saude') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, estudio: studioOnline(), fila: queue.length, aguardando: pending.size }));
    return;
  }
  if (parts[0] === '_estudio') {
    if (!secretOk(req.headers['x-estudio-chave'])) { res.writeHead(401).end(); return; }
    if (parts[1] === 'espera' && req.method === 'GET') return studioPoll(req, res, url);
    if (parts[1] === 'resposta' && req.method === 'POST') return void studioAnswer(req, res);
    res.writeHead(404).end();
    return;
  }
  // Só a página do celular e as mensagens dela passam (nada de replays, vídeos ou outras rotas do Estúdio).
  const allowed = (parts[0] === 'celular.js' && parts.length === 1 && req.method === 'GET')
    || (parts[0] === 'c' && parts.length >= 2 && parts.length <= 3 && /^[\w-]{10,64}$/.test(parts[1]) && (req.method === 'GET' || req.method === 'POST'));
  if (!allowed) {
    page(res, 404, 'Estúdio ao Vivo', 'Abra o link ou o QR Code que o operador do Estúdio enviou.');
    return;
  }
  void fromPhone(req, res, url);
});
// A consulta longa do celular e a busca do Estúdio ficam abertas por até 40 s.
server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;
server.listen(PORT, () => console.log(`[camera-relay] porta ${PORT}`));
