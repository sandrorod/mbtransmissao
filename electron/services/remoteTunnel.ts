import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteState } from '../../src/types/studio';

/** Endereço público que o túnel rápido da Cloudflare recebe (muda a cada vez que liga). */
const PUBLIC_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const READY = /Registered tunnel connection/;
const START_TIMEOUT_MS = 60000;
const MAX_RESTARTS = 3;

/**
 * Celulares de outra rede (4G, outro Wi‑Fi): liga um túnel rápido da Cloudflare até o servidor local dos
 * celulares. Não precisa de conta nem de domínio; o endereço é aleatório e só serve com o código do link.
 * O programa (cloudflared) é baixado na primeira vez para a pasta do app.
 */
export class RemoteTunnel {
  private child: ChildProcess | null = null;
  private wanted = false;
  private restarts = 0;
  state: RemoteState = { state: 'desligado', url: null, message: null };

  constructor(private dir: string, private log: (line: string) => void, private onChange: () => void) {}

  private set(next: RemoteState): void {
    this.state = next;
    this.onChange();
  }

  private get binary(): string {
    return join(this.dir, 'cloudflared');
  }

  /** Baixa o cloudflared oficial (GitHub da Cloudflare) se ainda não estiver na pasta do app. */
  private async ensureBinary(): Promise<void> {
    try {
      if ((await stat(this.binary)).size > 1_000_000) return;
    } catch {
      // Ainda não baixado.
    }
    this.set({ state: 'preparando', url: null, message: 'Baixando o túnel da Cloudflare (só na primeira vez)…' });
    await mkdir(this.dir, { recursive: true });
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`);
    if (!response.ok) throw new Error(`Não foi possível baixar o túnel (HTTP ${response.status}).`);
    const archive = join(this.dir, 'cloudflared.tgz');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('/usr/bin/tar', ['-xzf', archive, '-C', this.dir]);
      tar.on('error', reject);
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Não foi possível abrir o arquivo do túnel.'))));
    });
    await rm(archive, { force: true });
    await chmod(this.binary, 0o755);
  }

  async start(port: number): Promise<void> {
    this.wanted = true;
    this.restarts = 0;
    if (this.child) return;
    await this.launch(port);
  }

  private async launch(port: number): Promise<void> {
    try {
      await this.ensureBinary();
    } catch (e) {
      this.set({ state: 'erro', url: null, message: e instanceof Error ? e.message : String(e) });
      this.wanted = false;
      return;
    }
    if (!this.wanted || this.child) return;
    this.set({ state: 'preparando', url: null, message: 'Abrindo o endereço público…' });
    // O servidor dos celulares usa certificado próprio: o túnel fala com ele sem conferir o certificado (é o próprio Mac).
    const child = spawn(this.binary, ['tunnel', '--no-autoupdate', '--url', `https://127.0.0.1:${port}`, '--no-tls-verify'], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let url: string | null = null;
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready && this.child === child) {
        this.log('túnel: não abriu a tempo');
        child.kill();
      }
    }, START_TIMEOUT_MS);
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      url ??= text.match(PUBLIC_URL)?.[0] ?? null;
      if (!ready && url && READY.test(text)) {
        ready = true;
        clearTimeout(timer);
        this.restarts = 0;
        this.log(`túnel ligado: ${url}`);
        this.set({ state: 'ligado', url, message: null });
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (e) => this.log(`túnel: ${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) {
        this.set({ state: 'desligado', url: null, message: null });
        return;
      }
      this.log(`túnel caiu (código ${code ?? '?'})`);
      if (this.restarts < MAX_RESTARTS) {
        this.restarts++;
        this.set({ state: 'preparando', url: null, message: 'O endereço público caiu; abrindo outro (o link muda)…' });
        setTimeout(() => { if (this.wanted && !this.child) void this.launch(port); }, 2000);
      } else {
        this.wanted = false;
        this.set({ state: 'erro', url: null, message: 'Não foi possível manter o endereço público. Confira a internet e ligue de novo.' });
      }
    });
  }

  stop(): void {
    this.wanted = false;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.set({ state: 'desligado', url: null, message: null });
  }
}
