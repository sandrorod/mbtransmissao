import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import { PLATFORMS, isYoutubeDestination, type Destination, type DestinationInput, type Platform } from '../../src/types/studio';
import { validKey, validServer } from './destinationRules';

interface StoredDestination extends Destination {
  /** Chave criptografada pelo Keychain do macOS (safeStorage); nunca sai do processo principal. */
  keyEnc: string;
}


/** Destino como vai para a conta na nuvem (a chave em texto: lá ela fica protegida pela conta do usuário). */
export interface PortableDestination extends Destination {
  key: string;
}

export class DestinationStore {
  /** onChange: avisa a sincronização com a conta sempre que algo muda. */
  constructor(private file: string, private onChange: () => void = () => undefined) {}

  private async read(): Promise<StoredDestination[]> {
    try {
      const list = JSON.parse(await readFile(this.file, 'utf8')) as StoredDestination[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private async write(list: StoredDestination[]): Promise<void> {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
    this.onChange();
  }

  /** Para a conta na nuvem: chaves abertas (só no processo principal). */
  async exportPortable(): Promise<PortableDestination[]> {
    const out: PortableDestination[] = [];
    for (const { keyEnc, ...d } of await this.read()) {
      try {
        out.push({ ...d, key: safeStorage.decryptString(Buffer.from(keyEnc, 'base64')) });
      } catch {
        // Chave de outro Keychain que não abre aqui: não vai para a nuvem.
      }
    }
    return out;
  }

  /** Da conta na nuvem para este Mac: as chaves voltam a ser guardadas pelo Keychain daqui. */
  async importPortable(list: unknown[]): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('O Keychain do macOS não está disponível para guardar a chave com segurança.');
    const entries: StoredDestination[] = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const d = raw as Partial<PortableDestination>;
      if (!d || typeof d.id !== 'string' || !(String(d.platform) in PLATFORMS) || !validServer(String(d.server)) || !validKey(String(d.key))) continue;
      const key = String(d.key);
      entries.push({ id: d.id, platform: d.platform as Platform, name: String(d.name ?? '').slice(0, 60), server: String(d.server), enabled: d.enabled !== false, keyEnc: safeStorage.encryptString(key).toString('base64'), keyHint: key.slice(-4) });
    }
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
  }

  /**
   * Do arquivo de chaves: junta com os destinos daqui (o mesmo id é substituído). rename = novo id do destino
   * (o destino de um canal do YouTube acompanha o id que o canal ficou tendo aqui).
   */
  async mergePortable(list: unknown[], rename: (id: string) => string = (id) => id): Promise<number> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('O Keychain do macOS não está disponível para guardar a chave com segurança.');
    const current = await this.read();
    let count = 0;
    for (const raw of list) {
      const d = raw as Partial<PortableDestination>;
      if (!d || typeof d.id !== 'string' || d.id.length > 100 || !(String(d.platform) in PLATFORMS) || !validServer(String(d.server)) || !validKey(String(d.key))) continue;
      const key = String(d.key);
      const entry: StoredDestination = { id: rename(d.id), platform: d.platform as Platform, name: String(d.name ?? '').slice(0, 60), server: String(d.server), enabled: d.enabled !== false, keyEnc: safeStorage.encryptString(key).toString('base64'), keyHint: key.slice(-4) };
      const at = current.findIndex((x) => x.id === entry.id);
      if (at >= 0) current[at] = entry;
      else current.push(entry);
      count++;
    }
    await this.write(current);
    return count;
  }

  /** O que a interface pode ver: tudo, menos a chave (só os 4 últimos caracteres). */
  async list(): Promise<Destination[]> {
    return (await this.read()).map(({ keyEnc: _hidden, ...visible }) => visible);
  }

  async save(input: DestinationInput): Promise<Destination[]> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('O Keychain do macOS não está disponível para guardar a chave com segurança.');
    if (typeof input !== 'object' || !input || !(input.platform in PLATFORMS)) throw new Error('Plataforma inválida.');
    const name = String(input.name ?? '').trim().slice(0, 60) || PLATFORMS[input.platform as Platform].label;
    const server = String(input.server ?? '').trim();
    const key = String(input.key ?? '').trim();
    if (!validServer(server)) throw new Error('Servidor inválido: deve começar com rtmp:// ou rtmps://.');
    const list = await this.read();
    const existing = input.id ? list.find((d) => d.id === input.id) : undefined;
    if (!existing && !key) throw new Error('Informe a chave de transmissão.');
    if (key && !validKey(key)) throw new Error('Chave inválida: copie-a de novo da plataforma, sem espaços.');
    const secret = key ? { keyEnc: safeStorage.encryptString(key).toString('base64'), keyHint: key.slice(-4) } : { keyEnc: existing!.keyEnc, keyHint: existing!.keyHint };
    const entry: StoredDestination = { id: existing?.id ?? randomUUID(), platform: input.platform, name, server, enabled: input.enabled !== false, ...secret };
    await this.write(existing ? list.map((d) => (d.id === entry.id ? entry : d)) : [...list, entry]);
    return this.list();
  }

  /**
   * Destino mantido pelo próprio Estúdio (a live do YouTube escolhida na conta): id fixo, chave vinda da API.
   * Os destinos do YouTube cadastrados à mão são desligados para não mandar o vídeo duas vezes ao mesmo canal.
   */
  async upsertManaged(id: string, platform: Platform, name: string, server: string, key: string): Promise<Destination[]> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('O Keychain do macOS não está disponível para guardar a chave com segurança.');
    if (!validServer(server) || !validKey(key)) throw new Error('O YouTube devolveu um endereço de transmissão inesperado.');
    const entry: StoredDestination = { id, platform, name: name.slice(0, 60), server, enabled: true, keyEnc: safeStorage.encryptString(key).toString('base64'), keyHint: key.slice(-4) };
    // Os destinos do YouTube cadastrados à mão são desligados (podem ser o mesmo canal); os outros canais conectados continuam.
    const list = (await this.read()).filter((d) => d.id !== id).map((d) => (d.platform === platform && !isYoutubeDestination(d.id) ? { ...d, enabled: false } : d));
    await this.write([entry, ...list]);
    return this.list();
  }

  async remove(id: string): Promise<Destination[]> {
    await this.write((await this.read()).filter((d) => d.id !== id));
    return this.list();
  }

  /** Só para montar a saída do FFmpeg, aqui no processo principal. */
  async activeWithKeys(): Promise<{ id: string; name: string; url: string; key: string }[]> {
    return (await this.read())
      .filter((d) => d.enabled)
      .map((d) => {
        const key = safeStorage.decryptString(Buffer.from(d.keyEnc, 'base64'));
        const url = d.server.endsWith('/') ? `${d.server}${key}` : `${d.server}/${key}`;
        return { id: d.id, name: d.name, url, key };
      });
  }
}
