import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo, SessionSummary } from '../../src/types/studio';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{6,64}$/.test(id);
const CLIP = /^replay-\d{10,16}-\d{1,2}s(?:-c[a-z0-9]{1,16})?\.mp4$/;

/**
 * Transmissões: a atual usa a pasta de replays de sempre; as anteriores ficam guardadas em
 * transmissoes/<id>/ com o projeto (toda a configuração) e os replays daquela transmissão.
 */
export class Sessions {
  constructor(private root: string, private clipsDir: string, private currentFile: string) {}

  private async writeJson(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }

  /** Transmissão atual (criada na primeira vez com o nome do projeto). */
  async current(projectName = 'Transmissão'): Promise<SessionInfo> {
    try {
      const raw = JSON.parse(await readFile(this.currentFile, 'utf8')) as SessionInfo;
      if (validId(raw.id) && typeof raw.name === 'string') return raw;
    } catch { /* sem arquivo: cria */ }
    const info: SessionInfo = { id: randomUUID(), name: projectName.slice(0, 100) || 'Transmissão', createdAt: Date.now() };
    await this.writeJson(this.currentFile, info);
    return info;
  }

  private async replayStats(dir: string): Promise<{ replays: number; bytes: number }> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => CLIP.test(n));
    let bytes = 0;
    for (const n of names) bytes += (await stat(join(dir, n)).catch(() => null))?.size ?? 0;
    return { replays: names.length, bytes };
  }

  /** Transmissões guardadas, da mais recente para a mais antiga. */
  async list(): Promise<SessionSummary[]> {
    const ids = (await readdir(this.root).catch(() => [] as string[])).filter(validId);
    const out: SessionSummary[] = [];
    for (const id of ids) {
      try {
        const info = JSON.parse(await readFile(join(this.root, id, 'info.json'), 'utf8')) as SessionInfo & { archivedAt?: number };
        out.push({ id, name: String(info.name ?? 'Transmissão').slice(0, 100), createdAt: Number(info.createdAt) || 0, archivedAt: Number(info.archivedAt) || 0, ...(await this.replayStats(join(this.root, id, 'replays'))) });
      } catch { /* pasta incompleta: ignora */ }
    }
    return out.sort((a, b) => b.archivedAt - a.archivedAt);
  }

  /** Guarda a transmissão atual (projeto + replays) e deixa a pasta de replays vazia. */
  private async archiveCurrent(project: unknown): Promise<void> {
    const info = await this.current((project as { name?: string })?.name);
    const dir = join(this.root, info.id);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'replays');
    await rm(target, { recursive: true, force: true });
    if (existsSync(this.clipsDir)) await rename(this.clipsDir, target);
    else await mkdir(target, { recursive: true });
    await this.writeJson(join(dir, 'projeto.json'), project);
    await this.writeJson(join(dir, 'info.json'), { ...info, name: (project as { name?: string })?.name?.trim() || info.name, archivedAt: Date.now() });
    await mkdir(this.clipsDir, { recursive: true });
  }

  /** Nova transmissão: guarda a atual e começa outra com a mesma configuração, sem replays. */
  async startNew(name: string, project: unknown): Promise<SessionInfo> {
    await this.archiveCurrent(project);
    const info: SessionInfo = { id: randomUUID(), name: name.trim().slice(0, 100) || 'Transmissão', createdAt: Date.now() };
    await this.writeJson(this.currentFile, info);
    return info;
  }

  /** Recupera uma transmissão guardada: a atual é guardada e a escolhida volta (projeto e replays). */
  async restore(id: string, project: unknown): Promise<{ info: SessionInfo; project: unknown }> {
    if (!validId(id)) throw new Error('Transmissão inválida.');
    const dir = join(this.root, id);
    const saved = JSON.parse(await readFile(join(dir, 'projeto.json'), 'utf8').catch(() => { throw new Error('Esta transmissão não foi encontrada.'); })) as unknown;
    const info = JSON.parse(await readFile(join(dir, 'info.json'), 'utf8')) as SessionInfo;
    await this.archiveCurrent(project);
    await rm(this.clipsDir, { recursive: true, force: true });
    if (existsSync(join(dir, 'replays'))) await rename(join(dir, 'replays'), this.clipsDir);
    else await mkdir(this.clipsDir, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    const current: SessionInfo = { id, name: info.name, createdAt: info.createdAt };
    await this.writeJson(this.currentFile, current);
    return { info: current, project: saved };
  }

  /** Apaga de vez uma transmissão guardada (projeto e replays dela). */
  async remove(id: string): Promise<SessionSummary[]> {
    if (!validId(id)) throw new Error('Transmissão inválida.');
    await rm(join(this.root, id), { recursive: true, force: true });
    return this.list();
  }

  /** Renomeia a transmissão atual (acompanha o nome do projeto). */
  async rename(name: string): Promise<void> {
    const info = await this.current(name);
    if (name.trim() && info.name !== name.trim()) await this.writeJson(this.currentFile, { ...info, name: name.trim().slice(0, 100) });
  }
}
