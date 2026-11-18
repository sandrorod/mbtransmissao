import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReplayClip, ReplayFolder, ReplayPatch } from '../../src/types/studio';

/** Pedaços guardados além do maior replay possível (30 s), para nunca faltar começo. */
const KEEP_MS = 45_000;
const SEGMENT = /^seg\d{6}\.ts$/;
/** Programa: replay-<ms>-<s>s.mp4 · câmera: replay-<ms>-<s>s-<chave da câmera>.mp4 (mesmo corte, mesmos números). */
const CLIP = /^replay-(\d{10,16})-(\d{1,2})s(?:-(c[a-z0-9]{1,16}))?\.mp4$/;
/** Chave de uma câmera (vem da tela): curta e só com letras e números. */
export const validCamKey = (key: unknown): key is string => typeof key === 'string' && /^c[a-z0-9]{1,16}$/.test(key);

/** FFmpeg de uma câmera: recebe o vídeo gravado na tela e guarda pedaços de ~1 s (sem som). */
export function cameraArgs(inputFormat: 'webm' | 'matroska', copyVideo: boolean, dir: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-fflags', '+genpts', '-thread_queue_size', '512', '-f', inputFormat, '-i', 'pipe:0',
    '-map', '0:v:0', '-an',
    // H.264 da tela já vem com keyframe a cada 1 s: só reembala. VP8 precisa ser codificado (chip do Mac).
    ...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-allow_sw', '1', '-b:v', '6000k', '-g', '30', '-pix_fmt', 'yuv420p']),
    '-bsf:v', 'h264_mp4toannexb',
    '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', join(dir, 'seg%06d.ts'),
  ];
}

export const validClipId = (id: unknown): id is string => typeof id === 'string' && CLIP.test(id);

/**
 * Janela de relógio para procurar os pedaços do replay: 3× o tempo pedido + 5 s (até o que o buffer guarda).
 * O corte exato é feito depois, pelo tempo do próprio vídeo.
 */
export const replayWindow = (seconds: number) => Math.min(KEEP_MS - 2000, seconds * 3000 + 5000);

/** Quais pedaços cobrem os últimos `ms`: cada pedaço vai do fim do anterior até o fim dele (hora em que foi gravado). */
export function pickSegments(files: { name: string; mtimeMs: number; size: number }[], now: number, ms: number): string[] {
  return files
    .filter((f) => SEGMENT.test(f.name) && f.size > 0 && f.mtimeMs > now - ms)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => f.name);
}

type Meta = Required<Pick<ReplayClip, 'name' | 'note' | 'start'>> & { folder: string | null; end: number | null; source: string };
interface Library {
  meta: Record<string, Partial<Meta>>;
  folders: ReplayFolder[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600 ? Math.round(v * 10) / 10 : undefined);

/** Só os campos conhecidos, com tamanho e faixa conferidos (vem da tela). */
export function cleanPatch(v: unknown): ReplayPatch {
  if (!isObject(v)) return {};
  const out: ReplayPatch = {};
  if ('name' in v) out.name = short(v.name, 80)?.trim() ?? '';
  if ('note' in v) out.note = short(v.note, 500) ?? '';
  if ('folder' in v) out.folder = typeof v.folder === 'string' && v.folder.length <= 64 ? v.folder : null;
  if ('start' in v) out.start = seconds(v.start) ?? 0;
  if ('end' in v) out.end = v.end === null ? null : seconds(v.end) ?? null;
  if (out.end !== undefined && out.end !== null && out.start !== undefined && out.end <= out.start) out.end = null;
  return out;
}

export function cleanFolders(v: unknown): ReplayFolder[] {
  return (Array.isArray(v) ? v : []).flatMap((f: unknown) => (isObject(f) && typeof f.id === 'string' && f.id.length <= 64 && typeof f.name === 'string' && f.name.trim()
    ? [{ id: f.id, name: f.name.trim().slice(0, 80), collapsed: f.collapsed === true }]
    : [])).slice(0, 100);
}

export function parseClip(name: string, bytes: number): ReplayClip | null {
  const m = CLIP.exec(name);
  return m ? { id: name, createdAt: Number(m[1]), seconds: Number(m[2]), bytes } : null;
}

interface Camera {
  label: string;
  dir: string;
  child: ChildProcessWithoutNullStreams;
  cleaner: ReturnType<typeof setInterval>;
}

/**
 * Replay: durante a transmissão o FFmpeg grava, junto com o envio, pedaços de ~1 s do programa (sem codificar
 * de novo: é o mesmo vídeo que vai para as plataformas). ⌘R junta os pedaços dos últimos N segundos num MP4.
 */
export class ReplayStore {
  /** Pasta dos pedaços da transmissão atual (null = fora do ar). */
  private current: string | null = null;
  private cleaner: ReturnType<typeof setInterval> | null = null;

  /** Gravações das câmeras (não dependem da sessão do programa: reconexões não as interrompem). */
  private cameras = new Map<string, Camera>();

  constructor(private bufferRoot: string, private clipsDir: string, private ffmpeg: string, private log: (line: string) => void = () => undefined, private camRoot = `${bufferRoot}-cameras`) {}

  /** Começa (ou recomeça) a guardar os últimos segundos de uma câmera. */
  async camStart(key: string, label: string, inputFormat: 'webm' | 'matroska', copyVideo: boolean): Promise<void> {
    await this.camStop(key);
    const dir = join(this.camRoot, key);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(dir, { recursive: true });
    const child = spawn(this.ffmpeg, cameraArgs(inputFormat, copyVideo, dir), { stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf8')).slice(-400); });
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      if (this.cameras.get(key)?.child === child) {
        this.log(`replay da câmera ${label}: gravação parou (${err.trim() || `código ${code}`})`);
        clearInterval(this.cameras.get(key)!.cleaner);
        this.cameras.delete(key);
      }
    });
    const cleaner = setInterval(() => void this.prune(dir), 5000);
    cleaner.unref?.();
    this.cameras.set(key, { label, dir, child, cleaner });
    this.log(`replay da câmera ${label}: gravando (${copyVideo ? 'H.264 repassado' : 'VP8 → H.264'})`);
  }

  camWrite(key: string, chunk: Buffer): void {
    const cam = this.cameras.get(key);
    if (cam && cam.child.stdin.writable) cam.child.stdin.write(chunk);
  }

  async camStop(key: string): Promise<void> {
    const cam = this.cameras.get(key);
    if (!cam) return;
    this.cameras.delete(key);
    clearInterval(cam.cleaner);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { cam.child.kill('SIGKILL'); resolve(); }, 3000);
      cam.child.once('close', () => { clearTimeout(timeout); resolve(); });
      cam.child.stdin.end();
    });
    await rm(cam.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  async camStopAll(): Promise<void> {
    await Promise.all([...this.cameras.keys()].map((k) => this.camStop(k)));
    await rm(this.camRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  setLog(log: (line: string) => void): void {
    this.log = log;
  }

  /** Começo de uma transmissão (ou reconexão): pasta nova para os pedaços desta sessão. */
  async begin(session: number): Promise<string> {
    await this.end();
    const dir = join(this.bufferRoot, `sessao-${session}`);
    await mkdir(dir, { recursive: true });
    this.current = dir;
    this.cleaner = setInterval(() => void this.prune(dir), 5000);
    this.cleaner.unref?.();
    return dir;
  }

  /** Fim da transmissão: apaga os pedaços (os replays já cortados ficam). */
  async end(): Promise<void> {
    if (this.cleaner) clearInterval(this.cleaner);
    this.cleaner = null;
    this.current = null;
    // Espera o FFmpeg soltar os arquivos antes de apagar (a pasta da próxima sessão é outra).
    await rm(this.bufferRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  get active(): boolean {
    return this.current !== null;
  }

  private async prune(dir: string): Promise<void> {
    const now = Date.now();
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!SEGMENT.test(name)) continue;
      const s = await stat(join(dir, name)).catch(() => null);
      if (s && s.mtimeMs < now - KEEP_MS) await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }

  /** Junta os pedaços dos últimos `seconds` de uma pasta num MP4 (null = ainda sem vídeo ali). */
  private async cutDir(dir: string, seconds: number, now: number, id: string): Promise<ReplayClip | null> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const files = (await Promise.all(names.map(async (name) => {
      const s = await stat(join(dir, name)).catch(() => null);
      return s ? { name, mtimeMs: s.mtimeMs, size: s.size } : null;
    }))).filter((f): f is { name: string; mtimeMs: number; size: number } => f !== null);
    // Com o Mac sobrecarregado o FFmpeg grava mais devagar que o relógio: nos últimos 7 s de relógio podem
    // existir só 2 s de vídeo (replays saíam curtos). Pega uma janela bem maior e corta pelo tempo do vídeo.
    const chosen = pickSegments(files, now, replayWindow(seconds));
    if (chosen.length === 0) return null;
    const out = join(this.clipsDir, id);
    const full = `${out}.inteiro.mp4`;
    const run = (args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf8')).slice(-600); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Não deu para montar o replay (${err.trim() || `código ${code}`}).`))));
    });
    try {
      await run([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', `concat:${chosen.map((n) => join(dir, n)).join('|')}`,
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
        full,
      ]);
      // Os últimos `seconds` do vídeo (sem recodificar: começa no keyframe anterior, até ~1 s a mais).
      await run(['-hide_banner', '-loglevel', 'error', '-y', '-sseof', `-${seconds}`, '-i', full, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out]);
    } finally {
      await rm(full, { force: true }).catch(() => undefined);
    }
    // Tempo real do vídeo: logo depois de começar a transmissão ainda não existem os segundos pedidos.
    // O replay diz o tempo que tem de verdade (nome do arquivo e lista), nunca o pedido.
    const real = await this.duration(out);
    let finalId = id;
    let finalSeconds = seconds;
    if (real !== null && Math.round(real) < seconds) {
      finalSeconds = Math.max(1, Math.round(real));
      finalId = id.replace(`-${seconds}s`, `-${finalSeconds}s`);
      await rename(out, join(this.clipsDir, finalId));
    }
    const bytes = (await stat(join(this.clipsDir, finalId))).size;
    this.log(`replay: ${finalId} · ${chosen.length} pedaços · ${real !== null ? `${real.toFixed(1)} s de vídeo` : 'duração ?'} · ${Math.round(bytes / 1024)} KB`);
    return { id: finalId, createdAt: now, seconds: finalSeconds, bytes };
  }

  /** Duração de um vídeo em segundos (lida pelo FFmpeg); null se não der para ler. */
  private duration(file: string): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn(this.ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
      });
    });
  }

  /** ⌘R: corta os últimos `seconds` do Programa e de cada câmera conectada, todos do mesmo instante. */
  async cut(seconds: number): Promise<ReplayClip[]> {
    const dir = this.current;
    if (!dir && this.cameras.size === 0) throw new Error('Nenhuma câmera ou celular gravando para o replay. O replay usa os dispositivos da cena no ar (não widgets, mídias nem câmeras virtuais) durante a transmissão.');
    await mkdir(this.clipsDir, { recursive: true });
    const now = Date.now();
    const base = `replay-${now}-${seconds}s`;
    const started = Date.now();
    const jobs: Promise<ReplayClip | null>[] = [];
    if (dir) jobs.push(this.cutDir(dir, seconds, now, `${base}.mp4`));
    const cams = [...this.cameras.entries()];
    for (const [key, cam] of cams) {
      jobs.push(this.cutDir(cam.dir, seconds, now, `${base}-${key}.mp4`).then((c) => (c ? { ...c, source: cam.label } : null)).catch((e) => {
        this.log(`replay da câmera ${cam.label}: ${String(e)}`);
        return null;
      }));
    }
    const settled = await Promise.allSettled(jobs);
    const clips = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    const programError = dir && settled[0].status === 'rejected' ? settled[0].reason : null;
    if (clips.length === 0) throw programError instanceof Error ? programError : new Error('Ainda não há vídeo das câmeras gravado para o replay. Espere alguns segundos de transmissão.');
    // Guarda de qual câmera veio cada corte (o nome do arquivo só tem a chave).
    const sources = clips.filter((c) => c.source);
    if (sources.length) {
      const lib = await this.library();
      for (const c of sources) lib.meta[c.id] = { ...lib.meta[c.id], source: c.source };
      await this.saveLibrary(lib);
    }
    this.log(`replay: ${seconds} s · ${clips.length} vídeo(s) (programa ${dir ? 'sim' : 'não'}, ${cams.length} câmera(s)) · ${Date.now() - started} ms`);
    return clips;
  }

  /** Nome, pasta, observação e corte de cada replay, e as pastas (replays.json, junto dos vídeos). */
  private get libraryFile(): string {
    return join(this.clipsDir, 'replays.json');
  }

  private async library(): Promise<Library> {
    try {
      const raw = JSON.parse(await readFile(this.libraryFile, 'utf8')) as unknown;
      if (!isObject(raw)) return { meta: {}, folders: [] };
      const meta: Library['meta'] = {};
      if (isObject(raw.meta)) {
        for (const [id, m] of Object.entries(raw.meta)) {
          if (!validClipId(id)) continue;
          // "source" (câmera do replay) é gravado só pelo corte, nunca vem da tela.
          const source = isObject(m) ? short(m.source, 120) : undefined;
          meta[id] = { ...(cleanPatch(m) as Partial<Meta>), ...(source ? { source } : {}) };
        }
      }
      return { meta, folders: cleanFolders(raw.folders) };
    } catch {
      return { meta: {}, folders: [] };
    }
  }

  private async saveLibrary(lib: Library): Promise<void> {
    await mkdir(this.clipsDir, { recursive: true });
    const tmp = `${this.libraryFile}.tmp`;
    await writeFile(tmp, JSON.stringify(lib, null, 2));
    await rename(tmp, this.libraryFile);
  }

  async list(): Promise<ReplayClip[]> {
    const names = await readdir(this.clipsDir).catch(() => [] as string[]);
    const lib = await this.library();
    const folderIds = new Set(lib.folders.map((f) => f.id));
    const clips = await Promise.all(names.map(async (name): Promise<ReplayClip | null> => {
      if (!validClipId(name)) return null;
      const s = await stat(join(this.clipsDir, name)).catch(() => null);
      const clip = s ? parseClip(name, s.size) : null;
      if (!clip) return null;
      const m = lib.meta[name] ?? {};
      return { ...clip, ...m, folder: m.folder && folderIds.has(m.folder) ? m.folder : null };
    }));
    return clips.filter((c): c is ReplayClip => c !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(id: string, patch: unknown): Promise<ReplayClip[]> {
    this.path(id);
    const lib = await this.library();
    lib.meta[id] = { ...lib.meta[id], ...cleanPatch(patch) } as Partial<Meta>;
    await this.saveLibrary(lib);
    return this.list();
  }

  async folders(): Promise<ReplayFolder[]> {
    return (await this.library()).folders;
  }

  /** Pastas novas/renomeadas/apagadas (replays de uma pasta apagada ficam fora de pasta). */
  async saveFolders(folders: unknown): Promise<ReplayFolder[]> {
    const lib = await this.library();
    lib.folders = cleanFolders(folders);
    const ids = new Set(lib.folders.map((f) => f.id));
    for (const m of Object.values(lib.meta)) if (m.folder && !ids.has(m.folder)) m.folder = null;
    await this.saveLibrary(lib);
    return lib.folders;
  }

  path(id: string): string {
    if (!validClipId(id)) throw new Error('Replay inválido.');
    return join(this.clipsDir, id);
  }

  async remove(id: string): Promise<ReplayClip[]> {
    await rm(this.path(id), { force: true });
    const lib = await this.library();
    if (lib.meta[id]) {
      delete lib.meta[id];
      await this.saveLibrary(lib);
    }
    return this.list();
  }
}
