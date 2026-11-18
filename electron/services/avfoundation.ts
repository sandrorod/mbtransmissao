import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { parseDeviceList, parseModes } from '../../src/devices/avfoundation';
import { normalizeLabel } from '../../src/devices/identify';
import type { NativeDevices, VideoMode } from '../../src/types/studio';

/** Dentro do app instalado o binário fica fora do pacote asar, onde pode ser executado. */
const FFMPEG = (ffmpegStatic as unknown as string).replace('app.asar', 'app.asar.unpacked');

/** Roda o FFmpeg e devolve o que ele escreveu no stderr; nunca passa do tempo limite. */
function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      // Assim que a lista de modos aparece, não há por que esperar o FFmpeg desistir sozinho.
      if (/Error opening input/.test(text)) child.kill('SIGKILL');
    });
    child.on('error', () => { clearTimeout(timer); resolve(text); });
    child.on('close', () => { clearTimeout(timer); resolve(text); });
  });
}

/** Lista do próprio AVFoundation: é a mesma fonte que o macOS usa para câmeras, placas de captura e microfones. */
export async function listNativeDevices(): Promise<NativeDevices> {
  return parseDeviceList(await run(['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], 8000));
}

const cache = new Map<string, VideoMode[] | null>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * Modos reais de uma câmera: pede um tamanho impossível e o AVFoundation responde com tudo o que o aparelho aceita.
 * Uma consulta por vez, porque cada uma toca o dispositivo por um instante.
 */
export function probeVideoModes(label: string): Promise<VideoMode[] | null> {
  const key = normalizeLabel(label);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const job = queue.then(async () => {
    if (cache.has(key)) return cache.get(key)!;
    const native = await listNativeDevices();
    const index = native.video.findIndex((name) => normalizeLabel(name) === key);
    if (index < 0) return null;
    const text = await run(['-f', 'avfoundation', '-video_size', '1x1', '-framerate', '1', '-i', `${index}:none`, '-t', '0.1', '-f', 'null', '-'], 8000);
    const modes = parseModes(text);
    const result = modes.length > 0 ? modes : null;
    cache.set(key, result);
    return result;
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Ao religar um aparelho, os modos podem ser outros (outra placa com o mesmo nome, por exemplo). */
export function forgetVideoModes(): void {
  cache.clear();
}
