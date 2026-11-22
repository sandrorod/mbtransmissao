import { request } from 'node:https';
import type { RemoteState } from '../../src/types/studio';

/** Pedido de um celular que chegou ao servidor próprio (camera-relay) e precisa ser respondido pelo Estúdio. */
export interface RelayJob {
  id: string;
  method: string;
  path: string;
  type: string;
  body: string;
}

export interface RelayAnswer {
  id: string;
  status: number;
  type: string;
  csp: string;
  body: string;
}

/** Só a página do celular e as mensagens dela passam pela ponte (nunca replays ou outras rotas). */
export const relayPathAllowed = (path: string) => /^\/(celular\.js$|c\/[\w-]{10,64}(\/(eventos|espera|ice|enviar))?(\?|$))/.test(path);

/** Endereço do servidor sem barra no fim; só https (ou http://localhost para testes). */
export function relayBase(address: string): string | null {
  try {
    const url = new URL(address.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

const POLL_TIMEOUT_MS = 35_000;
const RETRY_MS = 3_000;

/**
 * Celulares de outra rede pelo domínio próprio do operador: o Estúdio fica buscando pedidos no servidor (camera-relay)
 * e responde cada um com o servidor local dos celulares. Funciona atrás de qualquer roteador (só conexões de saída),
 * o endereço nunca muda e o certificado é de verdade (sem aviso no celular).
 */
export class RelayClient {
  private wanted = false;
  private round = 0;
  private abort: AbortController | null = null;
  state: RemoteState = { state: 'desligado', url: null, message: null };

  constructor(
    private config: () => Promise<{ base: string; secret: string } | null>,
    /** Certificado do servidor local dos celulares (para conferir a conexão com ele). */
    private certificate: () => string,
    private log: (line: string) => void,
    private onChange: () => void,
  ) {}

  private set(next: RemoteState): void {
    const same = next.state === this.state.state && next.url === this.state.url && next.message === this.state.message;
    this.state = next;
    if (!same) this.onChange();
  }

  async start(port: number): Promise<void> {
    if (this.wanted) return;
    const config = await this.config();
    if (!config) {
      this.set({ state: 'erro', url: null, message: 'Preencha o endereço e a chave do seu servidor em “Meu servidor (domínio próprio)”.' });
      return;
    }
    this.wanted = true;
    const round = ++this.round;
    this.set({ state: 'preparando', url: null, message: `Ligando em ${config.base}…` });
    void this.loop(round, config, port);
  }

  stop(): void {
    this.wanted = false;
    this.round++;
    this.abort?.abort();
    this.abort = null;
    this.set({ state: 'desligado', url: null, message: null });
  }

  private async loop(round: number, config: { base: string; secret: string }, port: number): Promise<void> {
    let failures = 0;
    while (this.wanted && round === this.round) {
      const abort = new AbortController();
      this.abort = abort;
      const timer = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
      try {
        const first = this.state.state !== 'ligado';
        const res = await fetch(`${config.base}/_estudio/espera${first ? '?ola=1' : ''}`, { headers: { 'x-estudio-chave': config.secret }, signal: abort.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (round !== this.round) return;
        if (res.status === 401) {
          this.wanted = false;
          this.log('servidor próprio: chave recusada');
          this.set({ state: 'erro', url: null, message: 'O servidor recusou a chave. Confira se é a mesma do RELAY_SECRET no Easypanel.' });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const jobs = (await res.json()) as RelayJob[];
        if (failures > 0 || this.state.state !== 'ligado') this.log(`servidor próprio ligado: ${config.base}`);
        failures = 0;
        this.set({ state: 'ligado', url: config.base, message: null });
        if (Array.isArray(jobs)) for (const job of jobs) void this.answer(job, port, config);
      } catch (e) {
        clearTimeout(timer);
        if (round !== this.round || !this.wanted) return;
        failures++;
        if (failures === 1 || failures % 10 === 0) this.log(`servidor próprio sem resposta (${e instanceof Error ? e.message : String(e)})`);
        this.set({ state: 'preparando', url: null, message: `Sem contato com ${config.base}. Tentando de novo…` });
        await new Promise((done) => setTimeout(done, RETRY_MS));
      }
    }
  }

  /** Faz o pedido do celular ao servidor local e manda a resposta de volta. */
  private async answer(job: RelayJob, port: number, config: { base: string; secret: string }): Promise<void> {
    let answer: RelayAnswer;
    if (!job || typeof job.id !== 'string' || typeof job.path !== 'string' || !relayPathAllowed(job.path) || (job.method !== 'GET' && job.method !== 'POST')) {
      answer = { id: String(job?.id ?? ''), status: 404, type: '', csp: '', body: '' };
    } else {
      answer = await this.local(job, port).catch(() => ({ id: job.id, status: 502, type: '', csp: '', body: '' }));
    }
    try {
      await fetch(`${config.base}/_estudio/resposta`, {
        method: 'POST',
        headers: { 'x-estudio-chave': config.secret, 'content-type': 'application/json' },
        body: JSON.stringify(answer),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // O celular tenta de novo sozinho.
    }
  }

  private local(job: RelayJob, port: number): Promise<RelayAnswer> {
    return new Promise((resolve, reject) => {
      const body = job.method === 'POST' ? Buffer.from(typeof job.body === 'string' ? job.body : '', 'utf8') : null;
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: job.path,
          method: job.method,
          ca: this.certificate(),
          headers: {
            ...(body ? { 'content-type': typeof job.type === 'string' && job.type ? job.type.slice(0, 100) : 'application/json', 'content-length': String(body.length) } : {}),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({
            id: job.id,
            status: res.statusCode ?? 502,
            type: String(res.headers['content-type'] ?? ''),
            csp: String(res.headers['content-security-policy'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body ?? undefined);
    });
  }
}
