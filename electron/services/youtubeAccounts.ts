import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { PRIMARY_ID, YoutubeAccount, portableFromStored, storedFromPortable, type PortableYoutube, type Stored, type Vault, type YoutubeDeps } from './youtube';
import type { YoutubeState } from '../../src/types/studio';

interface Entry extends Stored {
  id: string;
}

type Deps = Omit<YoutubeDeps, 'file' | 'store' | 'id'> & { file: string };

const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

/**
 * Lista de canais do YouTube conectados ao Estúdio. Cada canal tem o próprio login (e pode usar o mesmo
 * cliente OAuth dos outros). Tudo fica num arquivo só; o formato antigo (uma conta) vira o canal "principal".
 */
export class YoutubeAccounts {
  private entries: Entry[] | null = null;
  private accounts = new Map<string, YoutubeAccount>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private deps: Deps) {}

  private async load(): Promise<Entry[]> {
    if (this.entries) return this.entries;
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(this.deps.file, 'utf8'));
    } catch {
      raw = null;
    }
    const r = raw as { accounts?: unknown } | Stored | null;
    if (r && Array.isArray((r as { accounts?: unknown }).accounts)) {
      this.entries = ((r as { accounts: Entry[] }).accounts).filter((e) => e && validId(e.id));
    } else if (r && typeof (r as Stored).clientId === 'string') {
      // Versão anterior: uma conta só = canal principal.
      this.entries = [{ ...(r as Stored), id: PRIMARY_ID }];
    } else {
      this.entries = [];
    }
    return this.entries;
  }

  private async persist(): Promise<void> {
    const list = this.entries ?? [];
    this.writing = this.writing.then(async () => {
      const temp = `${this.deps.file}.tmp`;
      await writeFile(temp, JSON.stringify({ accounts: list }), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.deps.file);
    });
    await this.writing;
  }

  /** Conta pronta para usar (login, lives, chave). */
  async get(id: string): Promise<YoutubeAccount> {
    const entries = await this.load();
    if (!entries.some((e) => e.id === id)) throw new Error('Canal do YouTube não encontrado.');
    let account = this.accounts.get(id);
    if (!account) {
      account = new YoutubeAccount({
        ...this.deps,
        id,
        file: undefined,
        store: {
          read: async () => {
            const e = (await this.load()).find((x) => x.id === id);
            if (!e) return null;
            const { id: _id, ...stored } = e;
            return stored;
          },
          write: async (stored) => {
            const list = await this.load();
            this.entries = stored ? list.map((x) => (x.id === id ? { ...stored, id } : x)) : list.filter((x) => x.id !== id);
            await this.persist();
          },
        },
      });
      this.accounts.set(id, account);
    }
    return account;
  }

  async list(): Promise<YoutubeState[]> {
    const out: YoutubeState[] = [];
    for (const e of await this.load()) out.push(await (await this.get(e.id)).state());
    return out;
  }

  /** Canal novo. Usa o mesmo cliente OAuth do primeiro canal configurado (é só fazer o login com a outra conta). */
  async add(): Promise<YoutubeState[]> {
    const list = await this.load();
    const base = list.find((e) => e.clientId);
    const entry: Entry = { id: list.length === 0 ? PRIMARY_ID : randomUUID(), clientId: base?.clientId ?? '', clientSecretEnc: base?.clientSecretEnc ?? '', refreshTokenEnc: null, channel: null, broadcast: null };
    this.entries = [...list, entry];
    await this.persist();
    this.deps.onChange?.();
    return this.list();
  }

  async remove(id: string): Promise<YoutubeState[]> {
    this.entries = (await this.load()).filter((e) => e.id !== id);
    this.accounts.delete(id);
    await this.persist();
    this.deps.onChange?.();
    return this.list();
  }

  /** Para a nuvem e para o arquivo de chaves: segredos abertos (só no processo principal). */
  async exportPortable(): Promise<PortableYoutube[]> {
    const out: PortableYoutube[] = [];
    for (const e of await this.load()) {
      const p = portableFromStored(e, this.deps.vault);
      if (p) out.push({ ...p, id: e.id });
    }
    return out;
  }

  private fromPortable(raw: unknown, vault: Vault): Entry | null {
    const stored = storedFromPortable(raw, vault);
    if (!stored) return null;
    const id = (raw as { id?: unknown })?.id;
    return { ...stored, id: validId(id) ? id : PRIMARY_ID };
  }

  /** Da nuvem: substitui a lista toda (aceita o formato antigo de uma conta só). Não avisa a sincronização. */
  async importPortable(raw: unknown): Promise<void> {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const entries: Entry[] = [];
    for (const item of list) {
      const e = this.fromPortable(item, this.deps.vault);
      if (e && !entries.some((x) => x.id === e.id)) entries.push(e);
    }
    this.entries = entries;
    this.accounts.clear();
    await this.persist();
  }

  /**
   * Do arquivo de chaves: junta com os canais daqui. O mesmo canal (mesmo id do YouTube) é atualizado no
   * lugar. Devolve, para cada canal importado, o id que ele ficou tendo aqui (para ligar os destinos).
   */
  async merge(raw: unknown[]): Promise<Map<string, string>> {
    const list = [...(await this.load())];
    const ids = new Map<string, string>();
    for (const item of raw) {
      const e = this.fromPortable(item, this.deps.vault);
      if (!e) continue;
      const same = e.channel ? list.findIndex((x) => x.channel?.id === e.channel!.id) : -1;
      const sameId = list.findIndex((x) => x.id === e.id);
      if (same >= 0) {
        ids.set(e.id, list[same].id);
        list[same] = { ...e, id: list[same].id };
      } else if (sameId >= 0 && !list[sameId].channel) {
        // Canal vazio (sem login) com o mesmo id: ocupa o lugar dele.
        ids.set(e.id, e.id);
        list[sameId] = e;
      } else {
        const id = sameId >= 0 ? randomUUID() : e.id;
        ids.set(e.id, id);
        list.push({ ...e, id });
      }
    }
    this.entries = list;
    for (const id of ids.values()) this.accounts.delete(id);
    await this.persist();
    this.deps.onChange?.();
    return ids;
  }
}
