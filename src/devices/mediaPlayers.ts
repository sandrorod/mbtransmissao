import { holder, registerDirectVideo } from '../program/frames';
import { mediaUrl, type MediaItem } from '../types/studio';

/** Fotos e vídeos do projeto atual, para o pool saber o que abrir em "midia:<id>". */
export const mediaRegistry = new Map<string, MediaItem>();

export interface MediaState {
  playing: boolean;
  time: number;
  duration: number;
  error: string | null;
}

interface Player {
  item: MediaItem;
  video: HTMLVideoElement | null;
  canvas: HTMLCanvasElement | null;
  timer: ReturnType<typeof setInterval> | null;
  audio: AudioContext | null;
  tracks: MediaStreamTrack[];
  /** Cópias entregues ao pool (Programa, Prévia, mixer); o tocador desliga quando todas param. */
  clones: MediaStreamTrack[];
  idleSince: number | null;
  error: string | null;
}

const players = new Map<string, Player>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};

export const mediaPlayers = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getVersion: () => version,
  state(id: string): MediaState | null {
    const p = players.get(id);
    if (!p) return null;
    const v = p.video;
    return { playing: Boolean(v && !v.paused && !v.ended), time: v?.currentTime ?? 0, duration: v && Number.isFinite(v.duration) ? v.duration : 0, error: p.error };
  },
  /** Vídeo: tocar, pausar, voltar ao começo ou ir a um ponto (segundos). */
  control(id: string, action: 'play' | 'pause' | 'restart' | number) {
    const v = players.get(id)?.video;
    if (!v) return;
    if (action === 'play') void v.play().catch(() => undefined);
    else if (action === 'pause') v.pause();
    else if (action === 'restart') {
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    } else v.currentTime = Math.max(0, Math.min(action, Number.isFinite(v.duration) ? v.duration : action));
    emit();
  },
  /** Ajustes mudaram (repetir): vale na hora. */
  update(item: MediaItem) {
    const p = players.get(item.id);
    if (!p) return;
    p.item = item;
    if (p.video) p.video.loop = item.loop;
  },
  /** A mídia saiu do projeto: desliga o tocador. */
  close(id: string) {
    const p = players.get(id);
    if (p) dispose(id, p);
  },
};

function dispose(id: string, p: Player): void {
  if (p.timer) clearInterval(p.timer);
  p.tracks.forEach((t) => t.stop());
  p.clones.forEach((t) => t.stop());
  if (p.video) {
    p.video.pause();
    p.video.removeAttribute('src');
    p.video.load();
    p.video.remove();
  }
  void p.audio?.close().catch(() => undefined);
  players.delete(id);
  emit();
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Não foi possível abrir a foto (o arquivo sumiu ou está corrompido).'));
  img.src = url;
});

/** Foto: desenhada num canvas que manda a imagem como vídeo (GIF animado continua animando). */
async function startImage(p: Player): Promise<void> {
  const img = await loadImage(mediaUrl(p.item));
  const scale = Math.min(1, 3840 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(2, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d')!;
  const animated = p.item.ext === 'gif';
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    track.requestFrame?.();
  };
  draw();
  // Foto parada: um quadro a cada 0,5 s basta (quem abrir depois recebe logo); GIF: 15 quadros/s.
  p.timer = setInterval(draw, animated ? 1000 / 15 : 500);
  p.canvas = canvas;
  p.tracks = [track];
}

/** Vídeo: toca num elemento escondido; imagem e som viram trilhas (o som vai para o mixer, não para o alto-falante). */
async function startVideo(p: Player): Promise<void> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.playsInline = true;
  video.loop = p.item.loop;
  video.src = mediaUrl(p.item);
  // Na página (cantinho de 1 px, como os outros vídeos do programa): fora dela o Chromium economiza o vídeo
  // e ele atualiza aos trancos — era a causa das travadas da mídia.
  video.muted = false;
  // Elemento pequeno (o compositor lê o quadro inteiro do mesmo jeito): 1080p como camada da página custava à toa.
  video.width = 320;
  video.height = 180;
  holder().appendChild(video);
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Não foi possível abrir o vídeo (o arquivo sumiu ou o formato não é suportado).'));
  });
  for (const event of ['play', 'pause', 'ended', 'seeked']) video.addEventListener(event, emit);
  const audio = new AudioContext();
  const destination = audio.createMediaStreamDestination();
  try {
    audio.createMediaElementSource(video).connect(destination);
  } catch {
    // Vídeo sem som: segue só com a imagem.
  }
  await video.play().catch(() => undefined);
  void audio.resume().catch(() => undefined);
  const captured = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream();
  p.video = video;
  p.audio = audio;
  p.tracks = [...captured.getVideoTracks(), ...destination.stream.getAudioTracks()];
}

async function playerFor(item: MediaItem): Promise<Player> {
  const existing = players.get(item.id);
  if (existing && existing.tracks.some((t) => t.readyState === 'live')) return existing;
  if (existing) dispose(item.id, existing);
  const p: Player = { item, video: null, canvas: null, timer: null, audio: null, tracks: [], clones: [], idleSince: null, error: null };
  players.set(item.id, p);
  try {
    if (item.kind === 'imagem') await startImage(p);
    else await startVideo(p);
  } catch (error) {
    dispose(item.id, p);
    throw error;
  }
  emit();
  return p;
}

/** Abre a mídia para o pool: cada pedido recebe cópias das trilhas (fechar uma não derruba as outras). */
export async function openMedia(id: string): Promise<MediaStream> {
  const item = mediaRegistry.get(id);
  if (!item) throw Object.assign(new Error('Mídia removida.'), { name: 'NotFoundError' });
  const p = await playerFor(item);
  const clones = p.tracks.filter((t) => t.readyState === 'live').map((t) => t.clone());
  // O Programa e a Prévia desenham direto o vídeo do arquivo (sem decodificar a captura de novo).
  if (p.video) for (const t of clones) if (t.kind === 'video') registerDirectVideo(t, p.video);
  p.clones.push(...clones);
  p.idleSince = null;
  return new MediaStream(clones);
}

// Ninguém mais usando (todas as cópias paradas há 5 s): desliga o tocador para não gastar o Mac à toa.
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    p.clones = p.clones.filter((t) => t.readyState === 'live');
    if (p.clones.length > 0) {
      p.idleSince = null;
      continue;
    }
    p.idleSince ??= now;
    if (now - p.idleSince > 5000) dispose(id, p);
  }
}, 2000);
