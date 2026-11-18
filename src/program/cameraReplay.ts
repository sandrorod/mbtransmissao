import { pool } from '../devices/pool';
import type { StreamSpec } from '../devices/mediaPool';

/** Formatos para gravar só a imagem de uma câmera (H.264 primeiro: o FFmpeg só reembala, sem codificar). */
const MIME_TYPES = ['video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm'];
const pickMime = () => MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

/** Chave curta e estável de uma câmera (vai no nome do arquivo do replay). */
export function camKey(deviceId: string): string {
  let h = 5381;
  for (let i = 0; i < deviceId.length; i++) h = ((h * 33) ^ deviceId.charCodeAt(i)) >>> 0;
  return `c${h.toString(36)}`;
}

export interface ReplayCamera {
  deviceId: string;
  label: string;
  spec: StreamSpec;
}

interface Running {
  label: string;
  poolKey: string;
  recorder: MediaRecorder | null;
  track: MediaStreamTrack | null;
  /** O processo principal já está pronto para receber os pedaços desta gravação. */
  starting: boolean;
}

/**
 * Durante a transmissão, cada câmera conectada fica gravando para o replay: ⌘R corta, além do Programa, os
 * últimos segundos de cada câmera (ângulos diferentes do mesmo lance). A câmera é aberta pelo pool (mesma
 * captura que a cena já usa; se ela não estiver na cena, é ligada só enquanto a transmissão durar).
 */
export class CameraReplay {
  private running = new Map<string, Running>();
  private unsubscribe: (() => void) | null = null;
  private wanted: ReplayCamera[] = [];
  private live = false;

  constructor(private log: (line: string) => void = (line) => window.studio.liveLog(line)) {}

  /** Chamado sempre que a transmissão ou a lista de câmeras muda. */
  sync(live: boolean, cameras: ReplayCamera[]): void {
    this.live = live;
    this.wanted = live ? cameras : [];
    if (live && !this.unsubscribe) this.unsubscribe = pool.subscribe(() => this.attach());
    const keep = new Set(this.wanted.map((c) => camKey(c.deviceId)));
    for (const [key, run] of this.running) {
      const cam = this.wanted.find((c) => camKey(c.deviceId) === key);
      // Câmera saiu, ou a configuração dela mudou (outra captura no pool): recomeça.
      if (!keep.has(key) || (cam && pool.get(run.poolKey)?.spec && JSON.stringify(pool.get(run.poolKey)!.spec.constraints) !== JSON.stringify(cam.spec.constraints))) this.drop(key);
    }
    for (const cam of this.wanted) {
      const key = camKey(cam.deviceId);
      if (!this.running.has(key)) this.running.set(key, { label: cam.label, poolKey: pool.acquire(cam.spec), recorder: null, track: null, starting: false });
    }
    if (!live && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.attach();
  }

  /** Liga o gravador quando a captura fica pronta (ou volta com outra imagem, depois de cair). */
  private attach(): void {
    if (!this.live) return;
    for (const [key, run] of this.running) {
      const track = pool.get(run.poolKey)?.stream?.getVideoTracks()[0] ?? null;
      if (!track || track.readyState !== 'live' || run.starting || (run.track === track && run.recorder?.state === 'recording')) continue;
      void this.record(key, run, track);
    }
  }

  private async record(key: string, run: Running, track: MediaStreamTrack): Promise<void> {
    this.stopRecorder(run);
    run.starting = true;
    run.track = track;
    const mimeType = pickMime();
    try {
      await window.studio.replayCamStart(key, run.label, mimeType);
    } catch (e) {
      run.starting = false;
      this.log(`replay da câmera ${run.label}: não começou (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    if (this.running.get(key) !== run || run.track !== track) {
      run.starting = false;
      return;
    }
    const h264 = /avc1|h264/i.test(mimeType);
    const options = { mimeType, videoBitsPerSecond: h264 ? 6_000_000 : 10_000_000, ...(h264 ? { videoKeyFrameIntervalDuration: 1000 } : {}) } as MediaRecorderOptions;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream([track]), options);
    } catch (e) {
      run.starting = false;
      this.log(`replay da câmera ${run.label}: gravador falhou (${e instanceof Error ? e.message : String(e)})`);
      void window.studio.replayCamStop(key);
      return;
    }
    // Pedaços na ordem em que saíram (ler o Blob é assíncrono).
    let queue = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0 || run.recorder !== recorder) return;
      const blob = event.data;
      queue = queue.then(async () => window.studio.replayCamChunk(key, await blob.arrayBuffer())).catch(() => undefined);
    };
    recorder.onerror = () => this.log(`replay da câmera ${run.label}: o gravador parou`);
    run.recorder = recorder;
    run.starting = false;
    recorder.start(250);
  }

  private stopRecorder(run: Running): void {
    const recorder = run.recorder;
    run.recorder = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  private drop(key: string): void {
    const run = this.running.get(key);
    if (!run) return;
    this.running.delete(key);
    this.stopRecorder(run);
    pool.release(run.poolKey);
    void window.studio.replayCamStop(key).catch(() => undefined);
  }

  /** Quantas câmeras estão gravando agora. */
  get count(): number {
    return [...this.running.values()].filter((r) => r.recorder?.state === 'recording').length;
  }

  dispose(): void {
    this.sync(false, []);
  }
}
