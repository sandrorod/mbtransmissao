import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { loadavg } from 'node:os';
import ffmpegStatic from 'ffmpeg-static';
import type { LiveStatus, OutputSettings } from '../../src/types/studio';

export const FFMPEG = (ffmpegStatic as unknown as string).replace('app.asar', 'app.asar.unpacked');

export interface LiveTarget {
  id: string;
  name: string;
  url: string;
  key: string;
}

/** Monta os argumentos do FFmpeg; exportado para testar sem transmitir. */
/**
 * copyVideo: o programa já chega em H.264 (feito pelo chip de vídeo do Mac, com keyframe a cada 2 s):
 * o FFmpeg só repassa, sem codificar de novo. Codificar duas vezes disputava o mesmo chip e o programa
 * caía para 5–10 quadros/s (live travando no YouTube).
 */
/**
 * replayDir: pasta onde o FFmpeg também grava pedaços de ~1 s do mesmo vídeo (para o replay do ⌘R).
 * É só mais uma saída do tee, sem codificar de novo; se ela falhar, a transmissão continua.
 */
export function liveArgs(output: OutputSettings, inputFormat: 'webm' | 'matroska', targets: LiveTarget[], copyVideo = false, replayDir: string | null = null): string[] {
  const { width, height, fps, bitrate, encoder } = output;
  const gop = String(fps * 2); // keyframe a cada 2 s: o que YouTube, Facebook e Twitch pedem
  const video = encoder === 'hardware'
    ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high', '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high'];
  // onfail=ignore: se uma plataforma cair, as outras continuam recebendo.
  const slaves = targets.map((t) => `[f=flv:onfail=ignore]${t.url}`);
  if (replayDir) slaves.push(`[f=segment:segment_time=1:segment_format=mpegts:bsfs/v=h264_mp4toannexb:onfail=ignore]${replayDir}/seg%06d.ts`);
  const tee = slaves.join('|');
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostats', '-stats_period', '1', '-progress', 'pipe:1',
    '-fflags', '+genpts', '-thread_queue_size', '1024', '-f', inputFormat, '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    ...(copyVideo
      ? ['-c:v', 'copy']
      : [
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        '-fps_mode', 'cfr', '-r', String(fps), '-color_range', 'tv',
        ...video,
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`, '-g', gop, '-keyint_min', gop,
      ]),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-flags', '+global_header',
    '-f', 'tee', tee,
  ];
}

/** Tira qualquer chave de um texto antes de mostrar ou registrar. */
export function hideKeys(text: string, targets: LiveTarget[]): string {
  let result = text;
  for (const t of targets) if (t.key) result = result.split(t.key).join('••••');
  return result;
}

/**
 * Uma transmissão: a tela do Estúdio manda pedaços do programa (vídeo + áudio) e o FFmpeg codifica
 * e envia para todos os destinos ao mesmo tempo.
 */
export class LiveSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private lastErrors: string[] = [];
  private inputBytes = 0;
  private watchdogs: ReturnType<typeof setTimeout>[] = [];
  private rate = { bytes: 0, at: Date.now(), kbps: 0 };
  private speedSamples: { t: number; us: number }[] = [];
  private lastSummary = 0;
  private lastMachine = 0;
  status: LiveStatus;

  constructor(private targets: LiveTarget[], private onStatus: (status: LiveStatus) => void, private log: (line: string) => void = () => undefined) {
    // (onStatus pode ser trocado por silence())
    this.status = { state: 'iniciando', startedAt: null, fps: 0, kbps: 0, message: 'Preparando o vídeo do programa…', destinations: targets.map((t) => ({ id: t.id, name: t.name, ok: true, error: null })) };
  }

  private update(patch: Partial<LiveStatus>): void {
    const before = this.status;
    this.status = { ...this.status, ...patch };
    if (before.state !== this.status.state || before.message !== this.status.message) this.log(`estado: ${this.status.state}${this.status.message ? ` · ${this.status.message}` : ''}`);
    this.onStatus(this.status);
  }

  /** Para tudo com uma explicação (nunca deixa a tela presa em "Iniciando"). */
  private fail(message: string): void {
    this.log(`falha: ${message}`);
    this.lastErrors.push(message);
    this.child?.kill('SIGKILL');
  }

  start(output: OutputSettings, inputFormat: 'webm' | 'matroska', copyVideo = false, replayDir: string | null = null): void {
    const names = this.targets.map((t) => t.name).join(', ');
    this.log(`início: ${output.width}x${output.height} ${output.fps}fps ${output.bitrate}k ${copyVideo ? 'vídeo repassado (H.264 do programa)' : output.encoder} · entrada ${inputFormat} · destinos: ${names}`);
    const child = spawn(FFMPEG, liveArgs(output, inputFormat, this.targets, copyVideo, replayDir), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.watchdogs.push(setTimeout(() => {
      if (this.inputBytes === 0 && this.child) this.fail('O programa não enviou vídeo para a transmissão em 12 s.');
    }, 12000));
    this.watchdogs.push(setTimeout(() => {
      if (this.status.state === 'iniciando' && this.child) this.fail(`Nenhuma plataforma aceitou o vídeo em 30 s. ${this.lastErrors.slice(-2).join(' ')}`.trim());
    }, 30000));
    child.stdin.on('error', () => undefined);
    let progress = '';
    child.stdout.on('data', (chunk: Buffer) => {
      progress += chunk.toString('utf8');
      const blocks = progress.split(/progress=(?:continue|end)\s*/);
      progress = blocks.pop() ?? '';
      for (const block of blocks) {
        const fps = Number(/(?:^|\n)fps=([\d.]+)/.exec(block)?.[1] ?? 0);
        // Com vários destinos o FFmpeg não informa "bitrate": calcula pelo total enviado e o tempo.
        const size = Number(/(?:^|\n)total_size=(\d+)/.exec(block)?.[1] ?? 0);
        const micros = Number(/(?:^|\n)out_time_us=(\d+)/.exec(block)?.[1] ?? 0);
        let kbps = Number(/(?:^|\n)bitrate=\s*([\d.]+)kbits/.exec(block)?.[1] ?? 0) || (micros > 0 && size > 0 ? Math.round((size * 8) / (micros / 1000)) : 0);
        // Vídeo repassado: o FFmpeg não informa tamanho nem taxa. A taxa é a do que o programa entrega.
        const t = Date.now();
        if (!kbps && t - this.rate.at >= 1000) {
          this.rate.kbps = Math.round(((this.inputBytes - this.rate.bytes) * 8) / (t - this.rate.at));
          this.rate = { ...this.rate, bytes: this.inputBytes, at: t };
        }
        kbps ||= this.rate.kbps;
        const frame = Number(/(?:^|\n)frame=(\d+)/.exec(block)?.[1] ?? 0);
        // Velocidade dos últimos ~5 s (a do FFmpeg é a média desde o início: os segundos de conexão com o
        // YouTube no começo a deixavam abaixo de 1 por minutos e o painel mostrava "internet ruim" sem ser).
        let speed: number | undefined;
        if (micros > 0) {
          this.speedSamples.push({ t, us: micros });
          while (this.speedSamples.length > 2 && t - this.speedSamples[0].t > 5000) this.speedSamples.shift();
          const first = this.speedSamples[0];
          if (t - first.t >= 2500) speed = Math.round(((micros - first.us) / 1000 / (t - first.t)) * 100) / 100;
        }
        if ((frame > 0 || micros > 0) && this.status.state !== 'ao-vivo') this.update({ state: 'ao-vivo', startedAt: Date.now(), message: null });
        else this.update({ fps, kbps, speed });
        if (t - this.lastSummary >= 10000 && this.status.state === 'ao-vivo') {
          this.lastSummary = t;
          this.log(`envio: ${kbps} kbps · velocidade ${speed ?? '?'}x (últimos 5 s)`);
          if (t - this.lastMachine >= 30000) {
            this.lastMachine = t;
            void machineReport().then((line) => line && this.log(line));
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const line = hideKeys(raw, this.targets);
        this.log(`ffmpeg: ${line}`);
        this.lastErrors = [...this.lastErrors.slice(-6), line];
        // "Slave muxer #1 failed" / "Slave '[...]url': error": marca só aquele destino.
        const index = /Slave muxer #(\d+) failed/.exec(raw)?.[1];
        const byUrl = this.targets.findIndex((t) => raw.includes(t.url));
        const failed = index !== undefined ? Number(index) : /Slave .*(error|failed)/i.test(raw) ? byUrl : -1;
        if (failed >= 0 && this.status.destinations[failed]) {
          const destinations = this.status.destinations.map((d, i) => (i === failed ? { ...d, ok: false, error: line.replace(/^\[[^\]]+\]\s*/, '').slice(0, 200) } : d));
          this.update({ destinations });
        }
      }
    });
    child.on('close', (code) => {
      this.child = null;
      this.watchdogs.forEach(clearTimeout);
      this.log(`ffmpeg terminou (código ${code}) · recebidos ${Math.round(this.inputBytes / 1024)} KB do programa`);
      if (this.stopping) this.update({ state: 'parado', fps: 0, kbps: 0 });
      else this.update({ state: 'erro', fps: 0, kbps: 0, message: `A transmissão parou (código ${code}). ${this.lastErrors.slice(-2).join(' ')}`.trim() });
    });
  }

  /** A plataforma encerrou a live: para de enviar e avisa (a tela não pode continuar dizendo "ao vivo"). */
  end(message: string): void {
    this.log(`encerrada pela plataforma: ${message}`);
    this.stopping = true;
    this.update({ state: 'erro', fps: 0, kbps: 0, message });
    // Daqui em diante a sessão não fala mais com a tela (o "erro" acima já foi dado).
    this.onStatus = () => undefined;
    if (this.child) {
      this.child.stdin.end();
      const child = this.child;
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }
  }

  /** Mostra um aviso na tela sem mudar o estado (ex.: situação da live no YouTube). */
  note(message: string): void {
    if (this.status.message !== message) this.update({ message });
  }

  /** Para sem avisar a tela (ela já está abrindo uma sessão nova). */
  silence(): void {
    this.onStatus = () => undefined;
    this.stop();
  }

  write(chunk: Buffer): void {
    if (!this.child || this.child.stdin.destroyed) return;
    if (this.inputBytes === 0) {
      this.log(`primeiro pedaço do programa: ${chunk.length} bytes`);
      this.update({ message: `Conectando a ${this.targets.map((t) => t.name).join(', ')}…` });
    }
    this.inputBytes += chunk.length;
    this.child.stdin.write(chunk);
  }

  stop(): void {
    this.stopping = true;
    if (!this.child) {
      this.update({ state: 'parado' });
      return;
    }
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }
}

/**
 * Estado do Mac durante a live: processador freado pelo calor (pmset CPU_Speed_Limit < 100) e carga.
 * Live real de 17/11: processador a 43% da velocidade, carga 44–108 → programa e celular picotando.
 */
export function machineReport(): Promise<string | null> {
  const load = loadavg()[0];
  return new Promise((done) => {
    if (process.platform !== 'darwin') return done(`Mac: carga ${load.toFixed(1)}`);
    execFile('pmset', ['-g', 'therm'], { timeout: 3000 }, (error, stdout) => {
      const limit = Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(stdout ?? '')?.[1] ?? 100);
      const hot = !error && limit < 100 ? `PROCESSADOR FREADO PELO CALOR: ${limit}% da velocidade · ` : '';
      done(`Mac: ${hot}carga ${load.toFixed(1)}`);
    });
  });
}
