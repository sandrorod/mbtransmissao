import type { NativeDevices, VideoMode } from '../types/studio';

/** Lê a saída de `ffmpeg -f avfoundation -list_devices true -i ""`. */
export function parseDeviceList(text: string): NativeDevices {
  const result: NativeDevices = { video: [], audio: [] };
  let section: keyof NativeDevices | null = null;
  for (const line of text.split('\n')) {
    if (/AVFoundation video devices/i.test(line)) section = 'video';
    else if (/AVFoundation audio devices/i.test(line)) section = 'audio';
    else {
      const match = /\]\s*\[(\d+)\]\s*(.+?)\s*$/.exec(line);
      if (match && section) result[section][Number(match[1])] = match[2];
    }
  }
  return { video: result.video.filter(Boolean), audio: result.audio.filter(Boolean) };
}

/** Taxas comuns usadas quando a câmera aceita uma faixa contínua de FPS. */
const COMMON_FPS = [5, 10, 15, 20, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
const roundFps = (fps: number) => Math.round(fps * 100) / 100;

/**
 * Lê a lista "Supported modes" que o AVFoundation imprime quando se pede um tamanho inexistente.
 * Cada linha é `LxA@[min max]fps`: vira um tamanho com as taxas que ele aceita de verdade.
 */
export function parseModes(text: string): VideoMode[] {
  const sizes = new Map<string, Set<number>>();
  for (const match of text.matchAll(/(\d+)x(\d+)@\[([\d.]+)\s+([\d.]+)\]fps/g)) {
    const key = `${match[1]}x${match[2]}`;
    const min = roundFps(Number(match[3]));
    const max = roundFps(Number(match[4]));
    const list = sizes.get(key) ?? new Set<number>();
    list.add(max);
    if (max > min) for (const fps of COMMON_FPS) if (fps >= min && fps <= max) list.add(fps);
    if (min !== max) list.add(min);
    sizes.set(key, list);
  }
  return [...sizes.entries()]
    .map(([key, fps]) => {
      const [width, height] = key.split('x').map(Number);
      return { width, height, fps: [...fps].sort((a, b) => b - a) };
    })
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

/** Taxas "inteiras" primeiro numa lista curta para o operador (60, 30, 25…), sem repetir 29 e 28. */
export function usefulFps(fps: number[]): number[] {
  const preferred = fps.filter((f) => COMMON_FPS.includes(f));
  return preferred.length > 0 ? preferred : fps;
}
