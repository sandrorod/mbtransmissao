import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';
import { PHONE_PAGE_HTML, PHONE_PAGE_SCRIPT } from '../../src/phone/page';
import type { PhoneEvent, PhoneInfo, PhoneSenderStats } from '../../src/types/studio';

interface Phone {
  id: string;
  name: string;
  /** Rede local: canal de eventos (SSE) aberto. Pelo link público: null (o celular busca as mensagens). */
  res: ServerResponse | null;
  /** Consulta longa: mensagens esperando o celular buscar e a busca que está aguardando agora. */
  queue: unknown[];
  waiter: { res: ServerResponse; timer: ReturnType<typeof setTimeout> } | null;
  /** Última vez que o celular apareceu (consulta longa: some se parar de buscar). */
  seen: number;
  ping: ReturnType<typeof setInterval>;
}

/** Servidores para o vídeo achar caminho entre redes diferentes (STUN; TURN quando configurado). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface Stored {
  token: string;
  /** Link secreto da página dos replays (separado do link dos celulares). */
  replayToken?: string;
  key: string;
  cert: string;
  ips: string[];
}

const MAX_PHONES = 16;
/** Consulta longa: a busca fica aberta até chegar mensagem ou passar este tempo. */
const POLL_WAIT_MS = 20000;
/** Sem buscar por este tempo, o celular conta como saído. */
const POLL_GONE_MS = 45000;
const PHONE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Endereços IPv4 da rede local (Wi‑Fi/cabo), os do Wi‑Fi primeiro. */
export function lanAddresses(): string[] {
  const result: { ip: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      result.push({ ip: a.address, rank: name === 'en0' ? 0 : name.startsWith('en') ? 1 : 2 });
    }
  }
  return result.sort((a, b) => a.rank - b.rank).map((r) => r.ip);
}

/** Compara o link secreto sem revelar, pelo tempo de resposta, quantos caracteres acertou. */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** O que o próprio celular diz que está mandando (só números e um motivo conhecido). */
export function senderStats(value: unknown): PhoneSenderStats | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown, max: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), max) : 0);
  const reasons = ['none', 'cpu', 'bandwidth', 'other'] as const;
  const limit = reasons.find((r) => r === v.limit) ?? 'none';
  return { width: n(v.width, 8000), height: n(v.height, 8000), fps: n(v.fps, 240), kbps: n(v.kbps, 200000), targetKbps: n(v.targetKbps, 200000), limit, rttMs: n(v.rttMs, 60000), battery: typeof v.battery === 'number' && v.battery >= 0 && v.battery <= 1 ? Math.round(v.battery * 100) : null, charging: v.charging === true };
}

const clean = (text: unknown, max: number) => (typeof text === 'string' ? text.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '');

/**
 * Servidor do celular na rede local: entrega a página (HTTPS, exigido pelo navegador para usar a câmera)
 * e leva as mensagens do WebRTC entre o celular e o Estúdio. O vídeo em si vai direto, sem passar por aqui.
 * O celular escuta por eventos HTTP (SSE) e responde por POST: funciona no Safari do iPhone com
 * certificado local, onde WebSocket costuma ser recusado.
 */
export class PhoneServer {
  private server: Server | null = null;
  private phones = new Map<string, Phone>();
  private stored: Stored | null = null;
  private studioReady = false;
  /** Removidos pelo operador: se ainda buscarem mensagens, recebem "removido" em vez de entrar de novo. */
  private removed = new Map<string, number>();
  /** STUN/TURN entregues ao celular (e usados pela tela do Estúdio). */
  ice: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  port = 0;
  error: string | null = null;

  constructor(private file: string, private emit: (event: PhoneEvent) => void) {}

  get token(): string {
    return this.stored?.token ?? '';
  }

  /** Certificado do servidor (a ponte do domínio próprio confere a conexão local com ele). */
  get certificate(): string {
    return this.stored?.cert ?? '';
  }

  get replayToken(): string {
    return this.stored?.replayToken ?? '';
  }

  /** Página dos replays (/r/<link secreto>/…): recebe o resto do caminho depois do link. */
  gallery: ((rest: string[], url: URL, req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

  /** Link novo da página dos replays: o antigo para de funcionar na hora. */
  async newReplayToken(): Promise<void> {
    if (!this.stored) return;
    this.stored.replayToken = randomBytes(18).toString('base64url');
    await writeFile(this.file, JSON.stringify(this.stored), { encoding: 'utf8', mode: 0o600 });
  }

  /** Certificado próprio com os IPs atuais; refeito só se a rede mudar. */
  private async load(): Promise<Stored> {
    const ips = lanAddresses();
    let stored: Stored | null = null;
    try {
      stored = JSON.parse(await readFile(this.file, 'utf8')) as Stored;
    } catch {
      stored = null;
    }
    const covers = stored && ips.every((ip) => stored!.ips.includes(ip));
    if (!stored || !covers) {
      const all = [...new Set([...(stored?.ips ?? []), ...ips])].slice(-8);
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'Estudio ao Vivo' }], {
        notAfterDate: new Date(Date.now() + 825 * 86400000),
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...all.map((ip) => ({ type: 7 as const, ip }))] }],
      });
      stored = { token: stored?.token ?? randomBytes(18).toString('base64url'), replayToken: stored?.replayToken, key: pems.private, cert: pems.cert, ips: all };
      await writeFile(this.file, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    }
    if (!stored.replayToken) {
      stored.replayToken = randomBytes(18).toString('base64url');
      await writeFile(this.file, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    }
    return stored;
  }

  async start(firstPort = 8443): Promise<void> {
    if (this.server) return;
    try {
      this.stored = await this.load();
      for (let port = firstPort; port < firstPort + 20; port++) {
        const server = createServer({ key: this.stored.key, cert: this.stored.cert }, (req, res) => this.handle(req, res));
        const ok = await new Promise<boolean>((resolve) => {
          server.once('error', () => resolve(false));
          server.listen(port, '0.0.0.0', () => resolve(true));
        });
        if (ok) {
          this.server = server;
          this.port = port;
          this.error = null;
          return;
        }
      }
      this.error = 'Nenhuma porta livre entre 8443 e 8462.';
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Link novo: o antigo deixa de aceitar celulares (os já conectados continuam). */
  async newToken(): Promise<void> {
    if (!this.stored) return;
    this.stored.token = randomBytes(18).toString('base64url');
    await writeFile(this.file, JSON.stringify(this.stored), { encoding: 'utf8', mode: 0o600 });
  }

  list(): PhoneInfo[] {
    return [...this.phones.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  /** A tela do Estúdio abriu: cada celular manda (de novo) a sua câmera. */
  setStudioReady(): PhoneInfo[] {
    this.studioReady = true;
    for (const phone of this.phones.values()) this.push(phone, { t: 'pronto' });
    return this.list();
  }

  send(id: string, message: unknown): void {
    const phone = this.phones.get(id);
    if (phone) this.push(phone, message);
  }

  remove(id: string): void {
    const phone = this.phones.get(id);
    if (!phone) return;
    this.removed.set(id, Date.now());
    this.push(phone, { t: 'removido' });
    this.drop(phone);
    phone.res?.end();
  }

  stop(): void {
    for (const phone of this.phones.values()) {
      phone.res?.end();
      if (phone.waiter) this.answer(phone, []);
    }
    this.phones.clear();
    this.server?.close();
    this.server = null;
  }

  private push(phone: Phone, message: unknown): void {
    if (phone.res) {
      phone.res.write(`data: ${JSON.stringify(message)}\n\n`);
      return;
    }
    phone.queue.push(message);
    if (phone.waiter) this.answer(phone, phone.queue.splice(0));
  }

  /** Responde a busca que está aguardando (consulta longa). */
  private answer(phone: Phone, messages: unknown[]): void {
    const waiter = phone.waiter;
    if (!waiter) return;
    phone.waiter = null;
    clearTimeout(waiter.timer);
    phone.seen = Date.now();
    waiter.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    waiter.res.end(JSON.stringify(messages));
  }

  private drop(phone: Phone): void {
    clearInterval(phone.ping);
    if (phone.waiter) this.answer(phone, phone.queue.splice(0));
    if (this.phones.get(phone.id) === phone) {
      this.phones.delete(phone.id);
      this.emit({ t: 'saiu', id: phone.id });
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'https://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (parts[0] === 'celular.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PHONE_PAGE_SCRIPT);
      return;
    }
    if (parts[0] === 'r' && this.gallery && this.stored?.replayToken && parts[1] && safeEqual(parts[1], this.stored.replayToken)) {
      void this.gallery(parts.slice(2), url, req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    const valid = parts[0] === 'c' && parts[1] && this.stored && parts[1] === this.stored.token;
    if (!valid) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:sans-serif;background:#0b0c0e;color:#f1f2f4;padding:24px"><h2>Link inválido ou expirado</h2><p>Peça ao operador um link ou QR Code novo.</p>');
      return;
    }
    if (parts.length === 2 && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob: mediastream:; img-src 'self' data:",
      });
      res.end(PHONE_PAGE_HTML);
      return;
    }
    if (parts[2] === 'eventos' && req.method === 'GET') return this.subscribe(url, req, res);
    if (parts[2] === 'espera' && req.method === 'GET') return this.poll(url, req, res);
    if (parts[2] === 'ice' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.ice));
      return;
    }
    if (parts[2] === 'enviar' && req.method === 'POST') return this.receive(req, res);
    res.writeHead(404).end();
  }

  private subscribe(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const id = url.searchParams.get('id') ?? '';
    const name = clean(url.searchParams.get('nome'), 40) || 'Celular';
    if (!PHONE_ID.test(id)) {
      res.writeHead(400).end();
      return;
    }
    const previous = this.phones.get(id);
    if (!previous && this.phones.size >= MAX_PHONES) {
      res.writeHead(429).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    if (previous) {
      // O mesmo celular reconectou (troca de rede, tela bloqueada): a conexão antiga sai sem avisar "saiu".
      clearInterval(previous.ping);
      this.phones.delete(id);
      previous.res?.end();
      if (previous.waiter) this.answer(previous, []);
    }
    this.removed.delete(id);
    const phone: Phone = { id, name, res, queue: [], waiter: null, seen: Date.now(), ping: setInterval(() => res.write(': ping\n\n'), 15000) };
    this.phones.set(id, phone);
    this.emit({ t: 'entrou', id, nome: name });
    if (this.studioReady) this.push(phone, { t: 'pronto' });
    // Se o celular passou para a consulta longa, fechar este canal antigo não o tira da lista.
    req.on('close', () => { if (phone.res === res) this.drop(phone); });
  }

  /**
   * Celular que entrou pelo link público (túnel): o túnel segura respostas contínuas (SSE), então o
   * celular busca as mensagens repetidamente; cada busca espera até chegar alguma (ou 20 s).
   */
  private poll(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const id = url.searchParams.get('id') ?? '';
    const name = clean(url.searchParams.get('nome'), 40) || 'Celular';
    if (!PHONE_ID.test(id)) {
      res.writeHead(400).end();
      return;
    }
    const removedAt = this.removed.get(id);
    if (removedAt !== undefined) {
      if (Date.now() - removedAt < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify([{ t: 'removido' }]));
        return;
      }
      this.removed.delete(id);
    }
    let phone = this.phones.get(id);
    if (phone?.res) {
      // Estava pela rede local e passou para o link público: troca o canal.
      phone.res.end();
      phone.res = null;
      clearInterval(phone.ping);
      phone.ping = this.gonePing(id);
    }
    if (!phone) {
      if (this.phones.size >= MAX_PHONES) {
        res.writeHead(429).end();
        return;
      }
      phone = { id, name, res: null, queue: [], waiter: null, seen: Date.now(), ping: this.gonePing(id) };
      this.phones.set(id, phone);
      this.emit({ t: 'entrou', id, nome: name });
      if (this.studioReady) phone.queue.push({ t: 'pronto' });
    }
    phone.seen = Date.now();
    // Só uma busca por vez: a anterior (se ficou pendurada) responde vazia.
    if (phone.waiter) this.answer(phone, []);
    const current = phone;
    current.waiter = { res, timer: setTimeout(() => this.answer(current, current.queue.splice(0)), POLL_WAIT_MS) };
    if (current.queue.length > 0) this.answer(current, current.queue.splice(0));
    req.on('close', () => {
      if (current.waiter?.res === res) {
        clearTimeout(current.waiter.timer);
        current.waiter = null;
      }
    });
  }

  /** Consulta longa: se o celular parar de buscar, sai da lista. */
  private gonePing(id: string): ReturnType<typeof setInterval> {
    return setInterval(() => {
      const phone = this.phones.get(id);
      if (phone && !phone.res && !phone.waiter && Date.now() - phone.seen > POLL_GONE_MS) this.drop(phone);
    }, 5000);
  }

  private receive(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const phone = typeof message.id === 'string' ? this.phones.get(message.id) : undefined;
      if (!phone) {
        res.writeHead(409).end();
        return;
      }
      phone.seen = Date.now();
      if (message.t === 'sinal') this.emit({ t: 'sinal', id: phone.id, dados: message.dados });
      if (message.t === 'nome') {
        phone.name = clean(message.nome, 40) || phone.name;
        this.emit({ t: 'nome', id: phone.id, nome: phone.name });
      }
      if (message.t === 'chat') {
        const texto = clean(message.texto, 500);
        if (texto) this.emit({ t: 'chat', id: phone.id, texto });
      }
      if (message.t === 'ouvir') this.emit({ t: 'ouvir', id: phone.id, on: message.on === true });
      if (message.t === 'falha') {
        const texto = clean(message.texto, 300);
        if (texto) this.emit({ t: 'falha', id: phone.id, texto });
      }
      if (message.t === 'estat') {
        const sent = senderStats(message.dados);
        if (sent) this.emit({ t: 'estat', id: phone.id, dados: sent });
      }
      res.writeHead(204).end();
    });
  }
}
