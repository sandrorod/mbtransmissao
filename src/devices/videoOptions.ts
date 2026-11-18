import type { VideoMode, VideoSettings } from '../types/studio';
import { usefulFps } from './avfoundation';

export interface VideoChoices {
  /** De onde vieram as opções: lista real do AVFoundation ou limites informados pela própria câmera. */
  source: 'avfoundation' | 'capacidades' | 'nenhuma';
  sizes: { width: number; height: number }[];
  fpsFor: (width: number, height: number) => number[];
}

const STANDARD_SIZES = [
  [3840, 2160], [2560, 1440], [1920, 1080], [1600, 1200], [1280, 960], [1280, 720], [1024, 768], [960, 540], [800, 600], [640, 480], [640, 360], [320, 240],
];
const STANDARD_FPS = [60, 59.94, 50, 30, 29.97, 25, 24, 15, 10, 5];

interface Range { min?: number; max?: number }

/**
 * Só oferece o que o aparelho aceita. Com a lista do AVFoundation, ela é usada tal como veio;
 * sem ela, os tamanhos e taxas comuns são filtrados pelos limites que a câmera informa.
 */
export function videoChoices(modes: VideoMode[] | null, capabilities: { width?: Range; height?: Range; frameRate?: Range } | null): VideoChoices {
  if (modes && modes.length > 0) {
    return {
      source: 'avfoundation',
      sizes: modes.map(({ width, height }) => ({ width, height })),
      fpsFor: (width, height) => usefulFps(modes.find((m) => m.width === width && m.height === height)?.fps ?? []),
    };
  }
  const w = capabilities?.width;
  const h = capabilities?.height;
  const f = capabilities?.frameRate;
  if (!w?.max || !h?.max) return { source: 'nenhuma', sizes: [], fpsFor: () => [] };
  const fits = (value: number, range?: Range) => (range?.min ?? 0) <= value && value <= (range?.max ?? Infinity);
  const sizes = STANDARD_SIZES.filter(([width, height]) => fits(width, w) && fits(height, h)).map(([width, height]) => ({ width, height }));
  if (!sizes.some((s) => s.width === w.max && s.height === h.max)) sizes.unshift({ width: w.max, height: h.max });
  const fps = STANDARD_FPS.filter((x) => fits(x, f));
  return { source: 'capacidades', sizes, fpsFor: () => fps };
}

/** Restrições de captura a partir das configurações escolhidas. */
export function videoConstraints(settings: VideoSettings | undefined): MediaTrackConstraints {
  if (!settings) return {};
  const c: MediaTrackConstraints = {};
  if (settings.width && settings.height) {
    c.width = { exact: settings.width };
    c.height = { exact: settings.height };
  } else {
    // Automático: a maior imagem da câmera. Sem pedir, o Chromium abre em 640×480 (4:3, recorte da
    // FaceTime que filma em 1280×720) e a imagem não encaixa no programa 16:9.
    c.width = { ideal: 1920 };
    c.height = { ideal: 1080 };
  }
  if (settings.fps) c.frameRate = { ideal: settings.fps, max: settings.fps };
  return c;
}

export const formatSize = (s: { width: number; height: number }) => `${s.width}×${s.height}`;
export const formatFps = (fps: number) => `${String(fps).replace('.', ',')} fps`;
