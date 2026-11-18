import type { LiveStatus, OutputSettings } from '../types/studio';
import type { OutputMethod } from './compositor';
import { audioClock, resumeAudio } from '../audio/engine';

/**
 * Formatos que o Chromium grava e o FFmpeg lê. H.264 primeiro (usa o chip de vídeo do Mac); se ele não
 * entregar vídeo, cai para VP8, feito pelo processador, que não disputa o chip com mais ninguém.
 */
// WebM com H.264 primeiro: nos testes no Mac Intel o Matroska/avc1 às vezes não entregava nenhum byte
// (0 KB/s) ao abrir, e o WebM/H.264 entregou em todas as tentativas, com a janela visível ou minimizada.
const MIME_TYPES = ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export const pickMimeType = (skip: Set<string> = new Set()) => MIME_TYPES.find((m) => !skip.has(m) && MediaRecorder.isTypeSupported(m)) ?? 'video/webm;codecs=vp8,opus';

const MAX_RETRIES = 5;
/**
 * Abaixo disso, em 2 s, o gravador não está entregando nada (nem o áudio sai sem vídeo).
 * Não pode ser alto: cena parada ou escura comprime muito (17 KB/s medidos com a câmera do Mac à noite)
 * e um limite de 30 KB/s derrubava transmissões saudáveis.
 */
const MIN_BYTES_PER_CHECK = 4 * 1024;
/** Verificações seguidas (de 2 s) sem dados antes de consertar a fonte. */
const STALLED_CHECKS = 2;

/**
 * Leva o programa (vídeo + mix de áudio) até o FFmpeg em pedaços de 250 ms e vigia o próprio fluxo:
 * se o gravador parar de entregar vídeo, troca de formato sozinho; se a conexão cair, reconecta.
 * As fontes e as cenas continuam como estão; o operador só vê o aviso.
 */
export class LiveController {
  private recorder: MediaRecorder | null = null;
  private video: MediaStreamTrack | null = null;
  private wanted = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private badFormats = new Set<string>();
  /** Quadros por segundo que o programa está entregando ao gravador (o FFmpeg não mede quando só repassa). */
  private programFps = 0;
  private fpsSamples: number[] = [];

  /** Método de captura atual do programa (alterna quando a fonte para de entregar quadros). */
  private method: OutputMethod = 'canvas';

  /**
   * videoTrack: cria a trilha de vídeo do programa; audio: mix do programa.
   * source (opcional): diagnóstico e conserto da fonte (quadros entregues, recriar o canvas).
   */
  constructor(
    private videoTrack: (fps: number, method: OutputMethod) => MediaStreamTrack,
    private audio: () => MediaStreamTrack[],
    private onStatus: (status: LiveStatus) => void,
    private source: { frames(): number; failures(): number; drawn(): number; rebuild(): void; painted?(): number } | null = null,
  ) {}

  async start(output: OutputSettings): Promise<void> {
    this.wanted = true;
    this.retries = 0;
    this.badFormats.clear();
    // Captura direta do canvas primeiro: é a que continua entregando vídeo com a janela minimizada ou atrás
    // do navegador (testado no Mac Intel). O gerador fica como alternativa se ela parar.
    this.method = 'canvas';
    this.unsubscribe ??= window.studio.onLiveStatus((status) => this.handle(status, output));
    await this.open(output);
  }

  private closeRecorder(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    this.video?.stop();
    this.video = null;
  }

  private async open(output: OutputSettings): Promise<void> {
    this.closeRecorder();
    const mimeType = pickMimeType(this.badFormats);
    const session = await window.studio.startLive(output, mimeType);
    if (!this.wanted) return;
    this.video = this.videoTrack(output.fps, this.method);
    // H.264 vai direto para a plataforma (o FFmpeg não codifica de novo): já sai no tamanho final.
    // Keyframe pedido a cada 1 s: pedindo 2 s, com o Mac sobrecarregado o YouTube mediu 5–7 s entre keyframes
    // (acima do limite de 4 s) e o player de quem assiste ficava "carregando". VP8 ainda é recodificado.
    const h264 = /avc1|h264/i.test(mimeType);
    const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number; videoBitrateMode?: 'constant' | 'variable' } = h264
      // Taxa constante: com a variável o codificador mandava de 0,3 a 6 Mbps num pedido de 9 (cena parada ou
      // quadro faltando = menos dados) e a qualidade no YouTube subia e descia. Constante = imagem estável.
      ? { mimeType, videoBitsPerSecond: output.bitrate * 1000, audioBitsPerSecond: 160_000, videoKeyFrameIntervalDuration: 1000, videoBitrateMode: 'constant' }
      : { mimeType, videoBitsPerSecond: Math.max(12_000_000, output.bitrate * 2500), audioBitsPerSecond: 256_000 };
    const recorder = new MediaRecorder(new MediaStream([this.video, ...this.audio()]), options);
    let bytes = 0;
    let checks = 0;
    let weak = 0;
    // Os pedaços saem na ordem em que o gravador os fez (ler um Blob é assíncrono e podia inverter a ordem).
    let queue = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0 || this.recorder !== recorder) return;
      bytes += event.data.size;
      const blob = event.data;
      queue = queue.then(async () => {
        const data = await blob.arrayBuffer();
        // O processo principal descarta pedaços de uma sessão que já foi trocada.
        window.studio.sendLiveChunk(session, data);
      }).catch(() => undefined);
    };
    recorder.onerror = (event) => {
      window.studio.liveLog(`gravador do programa falhou (${mimeType}): ${(event as unknown as { error?: Error }).error?.message ?? 'erro'}`);
      this.fallback(output, mimeType);
    };
    this.recorder = recorder;
    recorder.start(250);
    window.studio.liveLog(`gravador do programa: ${mimeType} · ${this.method} · ${output.width}x${output.height} ${output.fps}fps · ${Math.round((options.videoBitsPerSecond ?? 0) / 1000)} kbps${h264 ? ' · repassado sem recodificar' : ''}`);
    let lastAudio = audioClock().time;
    let lastFrames = this.source?.frames() ?? 0;
    let lastFailures = this.source?.failures() ?? 0;
    this.monitor = setInterval(() => {
      if (this.recorder !== recorder) return;
      checks++;
      const frames = this.source?.frames() ?? 0;
      const failures = this.source?.failures() ?? 0;
      const generated = Math.round((frames - lastFrames) / 2);
      const instant = this.method === 'gerador' ? generated : (this.source?.painted?.() ?? 0);
      // Média dos últimos ~10 s: uma queda de um instante não pode pintar o painel de vermelho.
      this.fpsSamples = [...this.fpsSamples.slice(-4), instant];
      this.programFps = Math.round(this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length);
      const saida = this.method === 'gerador' ? `saída ${Math.round((frames - lastFrames) / 2)} quadros/s${failures > lastFailures ? ` (${failures - lastFailures} falhas)` : ''}, ` : '';
      const fonte = this.source ? ` · ${saida}${this.method === 'canvas' && this.source.painted ? `programa ${this.source.painted()} quadros/s, ` : ''}imagens novas ${this.source.drawn()}/s` : '';
      lastFrames = frames;
      lastFailures = failures;
      // Áudio parado também trava o gravador (ele espera o áudio para soltar o vídeo).
      const audio = audioClock();
      const audioMoving = audio.time - lastAudio > 0.5;
      lastAudio = audio.time;
      if (!audioMoving || audio.state !== 'running') void resumeAudio();
      window.studio.liveLog(`programa gerando ${Math.round(bytes / 2 / 1024)} KB/s${fonte}${audioMoving ? '' : ` · ÁUDIO PARADO (${audio.state}), religando`}`);
      weak = bytes < MIN_BYTES_PER_CHECK ? weak + 1 : 0;
      bytes = 0;
      // Vários períodos seguidos sem nada: o vídeo do programa travou.
      if (weak >= STALLED_CHECKS && checks >= STALLED_CHECKS) this.fallback(output, mimeType);
    }, 2000);
  }

  /**
   * O vídeo parou de sair. Conserta primeiro a fonte (canvas novo e outro método de captura), porque
   * gravador sem nenhum quadro de vídeo não entrega nem o áudio, em qualquer formato. Só depois troca o formato.
   */
  private fallback(output: OutputSettings, mimeType: string): void {
    if (!this.wanted) return;
    this.source?.rebuild();
    this.method = this.method === 'gerador' ? 'canvas' : 'gerador';
    // Já passou por todos os formatos: recomeça a lista (com fonte nova, o primeiro pode voltar a funcionar).
    this.badFormats.add(mimeType);
    const remaining = MIME_TYPES.filter((m) => !this.badFormats.has(m) && MediaRecorder.isTypeSupported(m));
    if (remaining.length === 0) this.badFormats.clear();
    const next = pickMimeType(this.badFormats);
    window.studio.liveLog(`sem vídeo em ${mimeType}: canvas recriado, captura por ${this.method}, formato ${next}`);
    this.onStatus({ state: 'iniciando', startedAt: null, fps: 0, kbps: 0, message: 'Ajustando o formato do vídeo…', destinations: [] });
    void this.open(output).catch((e) => window.studio.liveLog(`falha ao trocar de formato: ${String(e)}`));
  }

  private handle(status: LiveStatus, output: OutputSettings): void {
    if (status.state === 'ao-vivo') this.retries = 0;
    // A live terminou na plataforma: tentar de novo não adianta (e mostraria "Reconectando…" à toa).
    if (status.state === 'erro' && /encerrou a live|já terminou|foi apagada/.test(status.message ?? '')) {
      this.wanted = false;
      this.closeRecorder();
      this.onStatus(status);
      return;
    }
    if (status.state === 'erro' && this.wanted && this.retries < MAX_RETRIES) {
      this.retries++;
      this.closeRecorder();
      // Cada nova tentativa recomeça com fonte nova e todos os formatos disponíveis.
      this.badFormats.clear();
      this.source?.rebuild();
      this.onStatus({ ...status, state: 'reconectando', message: `Conexão perdida. Tentando de novo (${this.retries}/${MAX_RETRIES})…` });
      this.retryTimer = setTimeout(() => void this.open(output).catch((e) => {
        // Não dá para reabrir (ex.: a live do YouTube terminou): para e mostra o motivo, em vez de ficar em "Reconectando…".
        this.wanted = false;
        this.closeRecorder();
        const text = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
        window.studio.liveLog(`reconexão impossível: ${text}`);
        this.onStatus({ ...status, state: 'erro', message: text });
      }), 3000);
      return;
    }
    this.onStatus(status.state === 'ao-vivo' && !status.fps ? { ...status, fps: this.programFps } : status);
  }

  /** endBroadcast: encerra também a live no YouTube; sem isso ela fica aberta para voltar a transmitir nela. */
  async stop(endBroadcast = false): Promise<void> {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.closeRecorder();
    await window.studio.stopLive(endBroadcast);
  }
}
