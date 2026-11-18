import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { IMAGE_EXTENSIONS, MEDIA_SCHEME, VIDEO_EXTENSIONS, type MediaFile } from '../../src/types/studio';

const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const allExtensions = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] as string[];

/** Precisa ser chamado antes de o app ficar pronto: o esquema serve vídeo em pedaços (para avançar/voltar). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
}

/**
 * Fotos e vídeos para exibir na transmissão. O arquivo é copiado para a pasta do app (o original pode
 * mudar de lugar) e servido à tela por um endereço próprio, lido aos pedaços: um vídeo grande não é
 * carregado inteiro na memória.
 */
export class MediaFiles {
  constructor(private dir: string) {}

  private file(id: string, ext: string): string | null {
    if (!ID.test(id) || !allExtensions.includes(ext)) return null;
    return join(this.dir, `${id}.${ext}`);
  }

  /** Atende estudio-midia://arquivo/<id>.<ext> (só arquivos desta pasta). */
  handle(): void {
    protocol.handle(MEDIA_SCHEME, async (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
      const dot = name.lastIndexOf('.');
      const path = dot > 0 ? this.file(name.slice(0, dot), name.slice(dot + 1).toLowerCase()) : null;
      if (!path) return new Response('Não encontrado', { status: 404 });
      const response = await net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
      // A tela captura a imagem do vídeo/foto (canvas/captureStream): precisa do CORS liberado para não "sujar" a captura.
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
  }

  /** Copia o arquivo escolhido para a pasta do app. */
  async import(path: string): Promise<MediaFile> {
    const ext = extname(path).slice(1).toLowerCase();
    if (!allExtensions.includes(ext)) throw new Error('Use foto (JPG, PNG, GIF, WebP) ou vídeo (MP4, MOV, M4V, WebM).');
    if ((await stat(path)).size > MAX_BYTES) throw new Error('O arquivo pode ter no máximo 4 GB.');
    await mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    await copyFile(path, join(this.dir, `${id}.${ext}`));
    const name = basename(path, extname(path)).slice(0, 80) || 'Mídia';
    return { id, name, ext, kind: (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? 'imagem' : 'video' };
  }

  async remove(id: string, ext: string): Promise<void> {
    const path = this.file(id, ext);
    if (path) await rm(path, { force: true });
  }
}
