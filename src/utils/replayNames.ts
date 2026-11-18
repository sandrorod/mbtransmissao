import type { ReplayClip } from '../types/studio';

/**
 * Nome do replay: o dado pelo operador ou "Replay N" (N = ordem do corte). Um corte gera um vídeo do Programa e
 * um de cada câmera: todos têm o mesmo N, com o nome da câmera junto.
 */
export function clipName(clips: ReplayClip[], id: string): string {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return 'Replay';
  if (clip.name) return clip.name;
  const cuts = [...new Set(clips.map((c) => c.createdAt))].sort((a, b) => b - a);
  const n = cuts.length - cuts.indexOf(clip.createdAt);
  const angles = clips.filter((c) => c.createdAt === clip.createdAt).length;
  return angles > 1 || clip.source ? `Replay ${n} · ${clip.source ?? 'Programa'}` : `Replay ${n}`;
}
