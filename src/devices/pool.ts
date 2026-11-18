import { useEffect, useState, useSyncExternalStore } from 'react';
import { phones } from '../phone/phones';
import type { WebPage } from '../types/studio';
import { MediaPool, specKey, type PoolEntry, type StreamSpec } from './mediaPool';
import { mediaRegistry, openMedia } from './mediaPlayers';

/** Páginas da web do projeto atual, para o pool saber o que abrir em "pagina:<id>". */
export const pageRegistry = new Map<string, WebPage>();

const notFound = (message: string) => Object.assign(new Error(message), { name: 'NotFoundError' });

/** Abre a captura certa: aparelho do Mac, celular conectado pelo link ou página da web. */
async function openCapture(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const track = (constraints.video || constraints.audio) as MediaTrackConstraints;
  const deviceId = (track.deviceId as { exact: string }).exact;
  if (deviceId.startsWith('celular:')) {
    const phoneTrack = phones.track(deviceId);
    if (!phoneTrack) throw notFound('O celular não está conectado.');
    return new MediaStream([phoneTrack]);
  }
  // Foto ou vídeo do computador (com o som do vídeo, que vai para o mixer).
  if (deviceId.startsWith('midia:')) return openMedia(deviceId.slice(6));
  if (deviceId.startsWith('pagina:')) {
    const page = pageRegistry.get(deviceId.slice(7));
    if (!page) throw notFound('Página removida.');
    // Captura da janela escondida da página (não pede permissão de gravação de tela), com o SOM da página:
    // ele vira um canal no mixer (antes era capturado sem áudio e o som do widget nunca ia para a live).
    // A janela fica muda no Mac; a captura recebe o áudio mesmo assim.
    const video = (id: string) => ({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, maxWidth: page.width, maxHeight: page.height, maxFrameRate: 30 } }) as unknown as MediaTrackConstraints;
    const audio = (id: string) => ({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } }) as unknown as MediaTrackConstraints;
    const sourceId = await window.studio.openPage(page);
    // Só captura o som quando o widget foi marcado como "com som".
    if (!page.audio) return navigator.mediaDevices.getUserMedia({ audio: false, video: video(sourceId) });
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audio(sourceId), video: video(sourceId) });
    } catch (error) {
      // Sem o áudio, pelo menos a imagem continua (o id da captura só vale uma vez: pede outro).
      window.studio.liveLog(`widget ${page.name}: captura com som falhou (${error instanceof Error ? error.message : String(error)}); só imagem`);
      const retryId = await window.studio.openPage(page);
      return navigator.mediaDevices.getUserMedia({ audio: false, video: video(retryId) });
    }
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

/** O pool do app: toda captura passa por aqui, então um dispositivo nunca é aberto duas vezes à toa. */
export const pool = new MediaPool(openCapture, {
  managed: (spec) => (spec.deviceId.startsWith('pagina:') && pageRegistry.has(spec.deviceId.slice(7))) || (spec.deviceId.startsWith('midia:') && mediaRegistry.has(spec.deviceId.slice(6))),
});

export interface PooledStream {
  stream: MediaStream | null;
  status: PoolEntry['status'] | 'parado';
  error: string | null;
  key: string | null;
}

/** Usa um dispositivo enquanto o componente estiver na tela; ao sair, solta a referência. */
export function usePooledStream(spec: StreamSpec | null): PooledStream {
  const id = spec ? specKey(spec) : null;
  const [key, setKey] = useState<string | null>(null);
  useSyncExternalStore(pool.subscribe, pool.getVersion);
  useEffect(() => {
    if (!spec) {
      setKey(null);
      return;
    }
    const acquired = pool.acquire(spec);
    setKey(acquired);
    return () => pool.release(acquired);
    // A identidade da captura é o specKey; o objeto spec muda a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const entry = key ? pool.get(key) : undefined;
  return { stream: entry?.stream ?? null, status: entry?.status ?? 'parado', error: entry?.error ?? null, key };
}
