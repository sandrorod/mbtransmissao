import { NO_CROP, type Border, type ChromaKey, type Transform, type VideoSettings } from '../types/studio';
import { ChromaKeyer } from './chroma';
import { FrameReader } from './frames';

const ASPECT: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 };

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parte visível da imagem, em pixels "como aparece" (depois de girar): primeiro a área escolhida
 * (widgets: só um pedaço da página), depois o corte da proporção das configurações (centralizado),
 * por fim o corte que o operador fez no programa.
 */
export function visibleArea(frame: Size, settings: VideoSettings | undefined, crop = NO_CROP, region: Rect | null = null): Rect {
  const sideways = settings?.rotation === 90 || settings?.rotation === 270;
  const full = sideways ? { w: frame.h, h: frame.w } : frame;
  const offset = region ? { x: region.x * full.w, y: region.y * full.h } : { x: 0, y: 0 };
  const shown = region ? { w: Math.max(1, region.w * full.w), h: Math.max(1, region.h * full.h) } : full;
  let base: Rect = { x: offset.x, y: offset.y, w: shown.w, h: shown.h };
  const aspect = settings && settings.aspect !== 'original' ? ASPECT[settings.aspect] : null;
  if (aspect) {
    if (shown.w / shown.h > aspect) {
      const w = shown.h * aspect;
      base = { x: offset.x + (shown.w - w) / 2, y: offset.y, w, h: shown.h };
    } else {
      const h = shown.w / aspect;
      base = { x: offset.x, y: offset.y + (shown.h - h) / 2, w: shown.w, h };
    }
  }
  return {
    x: base.x + crop.l * base.w,
    y: base.y + crop.t * base.h,
    w: base.w * Math.max(0.02, 1 - crop.l - crop.r),
    h: base.h * Math.max(0.02, 1 - crop.t - crop.b),
  };
}

/** Onde a fonte aparece na tela do programa (pixels do programa). Sem posição salva = encaixada inteira. */
export function placement(area: Rect, transform: Transform | null, canvas: Size): Rect {
  if (!transform) {
    const scale = Math.min(canvas.w / area.w, canvas.h / area.h);
    const w = area.w * scale;
    const h = area.h * scale;
    return { x: (canvas.w - w) / 2, y: (canvas.h - h) / 2, w, h };
  }
  const w = transform.w * canvas.w;
  return { x: transform.x * canvas.w, y: transform.y * canvas.h, w, h: transform.h !== undefined ? transform.h * canvas.h : (w * area.h) / area.w };
}

/** Posição salva equivalente à de agora (para começar a mover/redimensionar uma fonte encaixada). */
export function toTransform(rect: Rect, canvas: Size, crop = NO_CROP): Transform {
  return { x: rect.x / canvas.w, y: rect.y / canvas.h, w: rect.w / canvas.w, crop: { ...crop } };
}

/** Preenche a tela inteira cortando o que sobra (sem distorcer). */
export function fillTransform(frame: Size, settings: VideoSettings | undefined, canvas: Size, region: Rect | null = null): Transform {
  const full = visibleArea(frame, settings, NO_CROP, region);
  const target = canvas.w / canvas.h;
  const crop = { ...NO_CROP };
  if (full.w / full.h > target) {
    const cut = (1 - (full.h * target) / full.w) / 2;
    crop.l = cut;
    crop.r = cut;
  } else {
    const cut = (1 - full.w / target / full.h) / 2;
    crop.t = cut;
    crop.b = cut;
  }
  return { x: 0, y: 0, w: 1, crop };
}

/** Tela cheia: a imagem inteira, sem cortar, esticada para ocupar a tela toda (imagem quadrada fica mais larga). */
export function stretchTransform(): Transform {
  return { x: 0, y: 0, w: 1, h: 1, crop: { ...NO_CROP } };
}

/** Centraliza a fonte na tela sem mudar o tamanho nem o corte. rect = onde ela está agora (px do programa). */
export function centerTransform(rect: Rect, canvas: Size, current: Transform | null): Transform {
  const base = current ?? toTransform(rect, canvas);
  return { ...base, x: (canvas.w - rect.w) / 2 / canvas.w, y: (canvas.h - rect.h) / 2 / canvas.h };
}

/**
 * Guia do centro na altura: igual ao snapToCenterX, para o eixo vertical (y = borda de cima, h = altura).
 */
export function snapToCenterY(y: number, h: number, canvasH: number, threshold: number): { y: number; snapped: boolean } {
  const centered = canvasH / 2 - h / 2;
  return Math.abs(y - centered) <= threshold ? { y: centered, snapped: true } : { y, snapped: false };
}

/**
 * Guia do centro: se o centro da fonte (x = borda esquerda, w = largura, em pixels do programa) está a
 * menos de `threshold` do centro vertical da tela, encaixa exatamente no centro e avisa para mostrar a linha.
 */
export function snapToCenterX(x: number, w: number, canvasW: number, threshold: number): { x: number; snapped: boolean } {
  const centered = canvasW / 2 - w / 2;
  return Math.abs(x - centered) <= threshold ? { x: centered, snapped: true } : { x, snapped: false };
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const clampRegion = (r: Rect): Rect => ({ ...r, x: Math.min(Math.max(0, r.x), 1 - r.w), y: Math.min(Math.max(0, r.y), 1 - r.h) });

/**
 * Widget: arrastar o conteúdo dentro da moldura. dx/dy em pixels do programa; shown = onde o widget
 * aparece no programa (mesmos pixels). A moldura fica parada; a parte da página exibida anda ao contrário.
 */
export function panRegion(region: Rect | null, crop: Transform['crop'] | undefined, shown: Rect, dx: number, dy: number): Rect {
  const r = region ?? FULL;
  const c = crop ?? NO_CROP;
  const perX = (r.w * Math.max(0.02, 1 - c.l - c.r)) / Math.max(1, shown.w);
  const perY = (r.h * Math.max(0.02, 1 - c.t - c.b)) / Math.max(1, shown.h);
  return clampRegion({ ...r, x: r.x - dx * perX, y: r.y - dy * perY });
}

/**
 * Widget: arrastar uma borda (meio do topo, da base ou das laterais) aumenta ou diminui a MOLDURA,
 * mostrando mais ou menos da página, sem mudar o tamanho do conteúdo (a escala fica a mesma).
 * shown = onde o widget está no programa (px); d = quanto a borda andou (px do programa, + = direita/baixo).
 * Devolve a nova área da página e o novo retângulo no programa (a borda oposta fica parada).
 */
export function extendRegion(region: Rect | null, crop: Transform['crop'] | undefined, shown: Rect, edge: 'l' | 'r' | 't' | 'b', d: number): { region: Rect; rect: Rect } {
  const r = region ?? FULL;
  const c = crop ?? NO_CROP;
  const MIN = 0.02;
  if (edge === 'l' || edge === 'r') {
    const k = Math.max(0.02, 1 - c.l - c.r);
    const perPx = (r.w * k) / Math.max(1, shown.w);
    const grow = (edge === 'r' ? d : -d) * perPx / k;
    let w = Math.max(MIN, r.w + grow);
    let x = r.x;
    if (edge === 'r') w = Math.min(w, 1 - r.x);
    else {
      x = Math.max(0, r.x + r.w - w);
      w = r.x + r.w - x;
    }
    const width = (w * k) / perPx;
    return { region: { ...r, x, w }, rect: { ...shown, x: edge === 'l' ? shown.x + shown.w - width : shown.x, w: width } };
  }
  const k = Math.max(0.02, 1 - c.t - c.b);
  const perPx = (r.h * k) / Math.max(1, shown.h);
  const grow = (edge === 'b' ? d : -d) * perPx / k;
  let h = Math.max(MIN, r.h + grow);
  let y = r.y;
  if (edge === 'b') h = Math.min(h, 1 - r.y);
  else {
    y = Math.max(0, r.y + r.h - h);
    h = r.y + r.h - y;
  }
  const height = (h * k) / perPx;
  return { region: { ...r, y, h }, rect: { ...shown, y: edge === 't' ? shown.y + shown.h - height : shown.y, h: height } };
}

/**
 * Widget: aproximar (factor < 1) ou afastar (factor > 1) o conteúdo, mantendo a proporção da moldura
 * e o ponto (fx, fy, frações da moldura) parado sob o ponteiro.
 */
export function zoomRegion(region: Rect | null, factor: number, fx = 0.5, fy = 0.5): Rect {
  const r = region ?? FULL;
  const limit = Math.min(1 / r.w, 1 / r.h);
  const f = Math.min(Math.max(factor, 0.04 / Math.min(r.w, r.h)), limit);
  const w = r.w * f;
  const h = r.h * f;
  return clampRegion({ x: r.x + (r.w - w) * fx, y: r.y + (r.h - h) * fy, w, h });
}

/**
 * Tamanho do conteúdo dentro da moldura do widget, em %: 100% = largura inteira da página na moldura;
 * 200% = conteúdo duas vezes maior (mostra metade da largura). min = o menor possível (página inteira cabe).
 */
export function contentZoom(region: Rect | null): { value: number; min: number } {
  const r = region ?? FULL;
  return { value: 100 / r.w, min: 100 / (r.w * Math.min(1 / r.w, 1 / r.h)) };
}

/** Muda o tamanho do conteúdo para `percent`, mantendo o centro do que está à mostra. */
export function setContentZoom(region: Rect | null, percent: number): Rect {
  const r = region ?? FULL;
  return zoomRegion(r, 100 / percent / r.w, 0.5, 0.5);
}

/**
 * Retângulo da imagem original (antes de girar/espelhar) que corresponde à área visível.
 * O desenho gira em volta do centro: o centro da área visível é levado de volta ao quadro original.
 */
export function sourceRect(frame: Size, area: Rect, settings: VideoSettings | undefined): Rect {
  const rotation = settings?.rotation ?? 0;
  const sideways = rotation === 90 || rotation === 270;
  const shown = sideways ? { w: frame.h, h: frame.w } : frame;
  // Centro da área, relativo ao centro da imagem como aparece.
  const cx = area.x + area.w / 2 - shown.w / 2;
  const cy = area.y + area.h / 2 - shown.h / 2;
  const a = (-rotation * Math.PI) / 180;
  let sx = cx * Math.cos(a) - cy * Math.sin(a);
  const sy = cx * Math.sin(a) + cy * Math.cos(a);
  if (settings?.mirror) sx = -sx;
  const w = sideways ? area.h : area.w;
  const h = sideways ? area.w : area.h;
  return { x: frame.w / 2 + sx - w / 2, y: frame.h / 2 + sy - h / 2, w, h };
}

export interface Layer {
  id: string;
  /** Trilha de vídeo da fonte: o compositor lê cada quadro direto dela. */
  track: MediaStreamTrack | null;
  settings: VideoSettings | undefined;
  transform: Transform | null;
  hidden: boolean;
  /** Só um pedaço da imagem (widgets), em frações. */
  region?: Rect | null;
  /** Remove uma cor de fundo (chroma key). */
  chroma?: ChromaKey | null;
  /** Borda em volta da fonte. */
  border?: Border | null;
}

/** Retângulo com cantos arredondados (r já limitado à metade do lado menor). */
function roundedPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  if (radius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(radius, r.w / 2, r.h / 2));
  else ctx.rect(r.x, r.y, r.w, r.h);
}

/**
 * Borda desenhada por dentro do retângulo da fonte (não sai da tela quando a fonte ocupa a tela toda).
 * scale = altura do programa / 1080 (as medidas da borda são de uma tela 1080p).
 */
export function drawBorder(ctx: CanvasRenderingContext2D, dest: Rect, border: Border, scale: number): void {
  const lw = Math.max(1, border.width * scale);
  const radius = border.radius * scale;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = border.color;
  const inset = (by: number): Rect => ({ x: dest.x + by, y: dest.y + by, w: Math.max(1, dest.w - by * 2), h: Math.max(1, dest.h - by * 2) });
  const stroke = (by: number, width: number) => {
    ctx.lineWidth = width;
    roundedPath(ctx, inset(by), Math.max(0, radius - by));
    ctx.stroke();
  };
  switch (border.style) {
    case 'solida':
      stroke(lw / 2, lw);
      break;
    case 'tracejada':
      ctx.setLineDash([lw * 3, lw * 2]);
      stroke(lw / 2, lw);
      break;
    case 'pontilhada':
      ctx.lineCap = 'round';
      ctx.setLineDash([0.01, lw * 2]);
      stroke(lw / 2, lw);
      break;
    case 'dupla': {
      const part = Math.max(1, lw / 3);
      stroke(part / 2, part);
      stroke(lw - part / 2, part);
      break;
    }
    case 'neon':
      ctx.shadowColor = border.color;
      ctx.shadowBlur = lw * 2.5;
      stroke(lw / 2, lw);
      ctx.shadowBlur = lw;
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.7;
      stroke(lw / 2, Math.max(1, lw / 3));
      break;
    case 'sombra':
      // A sombra vai por baixo da imagem (desenhada antes dela, em paint).
      break;
  }
  ctx.restore();
}

/** Sombra da fonte: um retângulo do mesmo tamanho, por baixo dela, com a sombra deslocada para baixo/direita. */
function drawShadow(ctx: CanvasRenderingContext2D, dest: Rect, border: Border, scale: number): void {
  const lw = Math.max(1, border.width * scale);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowColor = border.color;
  ctx.shadowBlur = lw * 3;
  ctx.shadowOffsetX = lw;
  ctx.shadowOffsetY = lw;
  ctx.fillStyle = '#000';
  roundedPath(ctx, dest, border.radius * scale);
  ctx.fill();
  ctx.restore();
}

/**
 * Desenha o programa num canvas, camada por camada, no ritmo da transmissão.
 * Usa um temporizador (e não requestAnimationFrame) para continuar desenhando com a janela escondida.
 */
export type OutputMethod = 'gerador' | 'canvas';

/** O que vai por cima da cena neste quadro. */
export interface OverlayFrame {
  /** chroma: fundo removido (a cena aparece por baixo onde a cor some). */
  layers: { video: HTMLVideoElement; alpha: number; x: number; chroma?: ChromaKey }[];
  black: number;
}

export class Compositor {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layers: Layer[] = [];
  private readers = new Map<string, FrameReader>();
  private keyers = new Map<string, ChromaKeyer>();
  /** Quadros novos desenhados no último segundo (para mostrar a fluidez real do programa). */
  drawnFps = 0;
  private drawnCount = 0;
  private drawnSince = performance.now();
  private lastFrameIds = new Map<string, number>();
  /** Aviso quando o canvas perde o contexto gráfico (o Chromium reinicia a GPU). */
  onProblem: ((message: string) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fps = 30;
  /** Tamanho real de cada fonte (para a tela calcular onde desenhar as alças). */
  readonly sizes = new Map<string, Size>();

  /** Quadros que a trilha da transmissão conseguiu entregar (para saber se a fonte parou). */
  outputFrames = 0;
  /** Quadros que falharam ao sair do canvas. */
  outputFailures = 0;

  constructor(width: number, height: number, fps: number) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.createContext(width, height);
    this.fps = fps;
  }

  private createContext(width: number, height: number): CanvasRenderingContext2D {
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.addEventListener('contextlost', () => this.onProblem?.('O programa perdeu o acesso à placa de vídeo; reconstruindo…'));
    this.canvas.addEventListener('contextrestored', () => this.onProblem?.('Imagem do programa restaurada.'));
    return this.canvas.getContext('2d', { alpha: false })!;
  }

  /**
   * Troca o canvas do programa por um novo (contexto gráfico novo). Usado quando a transmissão para
   * de receber quadros: um canvas que perdeu a placa de vídeo pode continuar "desenhando" sem entregar nada.
   */
  rebuildCanvas(): void {
    const old = this.canvas;
    const { width, height } = old;
    this.canvas = document.createElement('canvas');
    this.ctx = this.createContext(width, height);
    // A prévia mostra o próprio canvas: o novo entra no mesmo lugar, com o mesmo tamanho na tela.
    this.canvas.style.cssText = old.style.cssText;
    this.canvas.className = old.className;
    old.replaceWith(this.canvas);
    // A captura era do canvas antigo; a transmissão abre uma nova logo em seguida.
    this.capture = null;
    for (const keyer of this.keyers.values()) keyer.dispose();
    this.keyers.clear();
    this.keyed.clear();
    this.onProblem?.(`canvas do programa recriado (${width}x${height})`);
  }

  get fpsValue(): number {
    return this.fps;
  }

  get size(): Size {
    return { w: this.canvas.width, h: this.canvas.height };
  }

  configure(width: number, height: number, fps: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (fps !== this.fps) {
      this.fps = fps;
      if (this.timer) {
        this.stop();
        this.start();
      }
    }
  }

  /**
   * Trilha de vídeo do programa para a transmissão: um quadro novo a cada 1/fps, escrito direto do canvas.
   * Não depende de a janela estar sendo desenhada na tela (como a captura comum do canvas).
   */
  outputTrack(fps: number, method: OutputMethod = 'gerador'): MediaStreamTrack {
    type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
    const Ctor = (window as unknown as { MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => Generator }).MediaStreamTrackGenerator;
    if (!Ctor || method === 'canvas') {
      // Captura manual: sai exatamente um quadro por desenho. Com captureStream(fps) a captura tinha relógio
      // próprio, desencontrado do desenho: repetia um quadro e pulava o seguinte (parecia "voltar um quadro").
      const manual = this.canvas.captureStream(0).getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
      if (!manual.requestFrame) return this.canvas.captureStream(fps).getVideoTracks()[0];
      this.capture = manual;
      return manual;
    }
    const generator = new Ctor({ kind: 'video' });
    const writer = generator.writable.getWriter();
    const started = performance.now();
    let busy = false;
    let failures = 0;
    const timer = setInterval(() => {
      if (generator.readyState === 'ended') {
        clearInterval(timer);
        void writer.close().catch(() => undefined);
        return;
      }
      if (busy) return;
      // Desenha agora e já captura: o quadro enviado é sempre o mais novo, sem desenhar duas vezes.
      this.lastOutputDraw = performance.now();
      this.draw();
      let frame: VideoFrame;
      try {
        frame = new VideoFrame(this.canvas, { timestamp: Math.round((performance.now() - started) * 1000) });
      } catch (error) {
        // Um quadro que falha não pode travar os próximos (antes travava a transmissão para sempre).
        failures++;
        this.outputFailures++;
        if (failures === 1 || failures % 150 === 0) this.onProblem?.(`quadro do programa falhou (${failures}x): ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      failures = 0;
      busy = true;
      const timeout = setTimeout(() => { busy = false; }, 1000);
      writer.write(frame).then(() => { this.outputFrames++; }, () => frame.close()).finally(() => {
        clearTimeout(timeout);
        busy = false;
      });
    }, 1000 / fps);
    return generator;
  }

  /**
   * Vídeos que ocupam o programa inteiro por cima da cena (replay, abertura). Consultado a cada quadro, para as
   * transições: alpha = opacidade, x = deslocamento em frações da largura, black = opacidade do preto por cima.
   */
  private overlay: (() => OverlayFrame) | null = null;
  /** Remoção de fundo do vídeo por cima (abertura do replay). */
  private overlayKeyer = new ChromaKeyer();
  private overlayStamp = '';

  setOverlay(frame: (() => OverlayFrame) | null): void {
    this.overlay = frame;
  }

  setLayers(layers: Layer[]): void {
    this.layers = layers;
    const ids = new Set(layers.map((l) => l.id));
    for (const layer of layers) {
      const reader = this.readers.get(layer.id);
      if (reader && reader.track === layer.track) continue;
      reader?.stop();
      if (layer.track) {
        const created = new FrameReader(layer.track);
        created.onFrame = () => this.kick();
        this.readers.set(layer.id, created);
      } else this.readers.delete(layer.id);
    }
    for (const [id, reader] of this.readers) {
      if (!ids.has(id)) {
        reader.stop();
        this.readers.delete(id);
        this.keyers.get(id)?.dispose();
        this.keyers.delete(id);
        this.keyed.delete(id);
      }
    }
  }

  /**
   * Desenha quando chega quadro novo de uma câmera (no máximo fps por segundo): cada imagem da câmera vira
   * um quadro do programa, sem repetir nem pular por desencontro de relógios. O relógio fixo só cobre o que
   * não avisa quadro novo: replay/vinheta por cima, cena sem câmera e janela minimizada (sem avisos).
   * Durante a transmissão pelo gerador quem desenha é a própria saída (um desenho por quadro enviado).
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - this.lastOutputDraw < 250) return;
      const kicked = now - this.lastKick < 200;
      // Avisos chegando: só completa se ficou mais de 1,5 quadro sem desenho (o Chromium agrupa avisos
      // quando a página está ocupada; desenhar só nos avisos perderia quadros).
      if (kicked && !this.overlay && now - this.lastPaint < 1500 / this.fps) return;
      if (now - this.lastPaint < this.gap()) return;
      this.draw();
    }, 1000 / this.fps);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }

  /** Captura manual da transmissão (um quadro por desenho). */
  private capture: (MediaStreamTrack & { requestFrame?: () => void }) | null = null;
  private lastPaint = 0;
  private lastKick = 0;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Intervalo mínimo entre desenhos (um pouco abaixo de 1/fps para não perder quadro por atraso do relógio). */
  private gap(): number {
    return 1000 / this.fps - 4;
  }

  private kick(): void {
    this.lastKick = performance.now();
    if (!this.timer || this.kickTimer) return;
    if (this.lastKick - this.lastOutputDraw < 250) return;
    const wait = Math.max(0, this.lastPaint + this.gap() - this.lastKick);
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.draw();
    }, wait);
  }

  /** Último desenho feito pela saída da transmissão (enquanto ela desenha, o relógio próprio descansa). */
  private lastOutputDraw = 0;
  /** Último quadro de cada fonte que passou pela remoção de fundo (página parada não é processada de novo). */
  private keyed = new Map<string, string>();

  /** Tempo médio de cada desenho do programa, em ms (diagnóstico). */
  drawMs = 0;

  /** Desenhos completos do programa por segundo (o ritmo real do vídeo que sai). */
  paintedFps = 0;
  private paintedCount = 0;
  private paintedSince = performance.now();

  draw(): void {
    const t0 = performance.now();
    this.lastPaint = t0;
    this.paint();
    const capture = this.capture;
    if (capture?.readyState === 'live') capture.requestFrame?.();
    else if (capture) this.capture = null;
    this.drawMs = this.drawMs * 0.9 + (performance.now() - t0) * 0.1;
    this.paintedCount++;
    if (t0 - this.paintedSince >= 1000) {
      this.paintedFps = Math.round((this.paintedCount * 1000) / (t0 - this.paintedSince));
      this.paintedCount = 0;
      this.paintedSince = t0;
    }
  }

  private paint(): void {
    const { ctx } = this;
    const canvas = this.size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.w, canvas.h);
    ctx.imageSmoothingQuality = 'high';
    let fresh = false;
    const overlay = this.overlay?.() ?? null;
    const shown = (overlay?.layers ?? []).filter((l) => l.alpha > 0 && l.video.readyState >= 2 && l.video.videoWidth > 0);
    // Um vídeo inteiro e opaco por cima (sem fundo removido): a cena não aparece (nem precisa ser desenhada).
    const covered = shown.some((l) => l.alpha >= 1 && Math.abs(l.x) < 0.0001 && !l.chroma?.enabled);
    for (const layer of covered ? [] : this.layers) {
      const reader = this.readers.get(layer.id);
      const latest = reader?.latest;
      if (!reader || !latest) continue;
      // Oculta não vai ao ar, mas o tamanho fica conhecido: a tela mostra a moldura pontilhada para selecionar e ajustar.
      if (layer.hidden) {
        this.sizes.set(layer.id, { w: latest.videoWidth, h: latest.videoHeight });
        continue;
      }
      if (this.lastFrameIds.get(layer.id) !== reader.frames) {
        this.lastFrameIds.set(layer.id, reader.frames);
        fresh = true;
      }
      const frame = { w: latest.videoWidth, h: latest.videoHeight };
      this.sizes.set(layer.id, frame);
      let image: CanvasImageSource = latest;
      if (layer.chroma?.enabled) {
        let keyer = this.keyers.get(layer.id);
        if (!keyer) {
          keyer = new ChromaKeyer();
          this.keyers.set(layer.id, keyer);
        }
        const stamp = `${reader.frames}|${layer.chroma.color}|${layer.chroma.similarity}|${layer.chroma.smoothness}`;
        if (this.keyed.get(layer.id) === stamp && keyer.canvas.width > 0) image = keyer.canvas;
        else {
          const out = keyer.process(latest, layer.chroma);
          image = out ?? latest;
          if (out) this.keyed.set(layer.id, stamp);
        }
      }
      const area = visibleArea(frame, layer.settings, layer.transform?.crop, layer.region ?? null);
      const dest = placement(area, layer.transform, canvas);
      const src = sourceRect(frame, area, layer.settings);
      const rotation = layer.settings?.rotation ?? 0;
      const sideways = rotation === 90 || rotation === 270;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(dest.x + dest.w / 2, dest.y + dest.h / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(layer.settings?.mirror ? -1 : 1, 1);
      const w = sideways ? dest.h : dest.w;
      const h = sideways ? dest.w : dest.h;
      const border = layer.border ?? null;
      const scale = canvas.h / 1080;
      if (border) {
        ctx.save();
        // Sombra: sem cantos arredondados ela segue o contorno da própria imagem (PNG transparente não ganha caixa preta).
        if (border.style === 'sombra' && border.radius > 0) drawShadow(ctx, dest, border, scale);
        else if (border.style === 'sombra') {
          const lw = Math.max(1, border.width * scale);
          ctx.shadowColor = border.color;
          ctx.shadowBlur = lw * 3;
          ctx.shadowOffsetX = lw;
          ctx.shadowOffsetY = lw;
        }
        // Cantos arredondados: a imagem é recortada no mesmo formato da borda.
        if (border.radius > 0) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          roundedPath(ctx, dest, border.radius * scale);
          ctx.clip();
          ctx.translate(dest.x + dest.w / 2, dest.y + dest.h / 2);
          ctx.rotate((rotation * Math.PI) / 180);
          ctx.scale(layer.settings?.mirror ? -1 : 1, 1);
        }
      }
      try {
        ctx.drawImage(image, src.x, src.y, src.w, src.h, -w / 2, -h / 2, w, h);
      } catch {
        // Quadro indisponível por um instante (troca de câmera): a camada some só nesse quadro.
      }
      if (border) {
        ctx.restore();
        drawBorder(ctx, dest, border, scale);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Replay/abertura por cima: encaixado, com faixas pretas se a proporção for outra.
    for (const l of shown) {
      const v = l.video;
      const scale = Math.min(canvas.w / v.videoWidth, canvas.h / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      ctx.globalAlpha = Math.min(1, l.alpha);
      const dx = l.x * canvas.w;
      // Mesmo quadro do vídeo e mesma cor: reaproveita o resultado (não reprocessa 1080p à toa a cada desenho).
      let keyed: HTMLCanvasElement | null = null;
      if (l.chroma?.enabled) {
        const stamp = `${v.currentSrc}|${v.currentTime}|${l.chroma.color}|${l.chroma.similarity}|${l.chroma.smoothness}`;
        if (this.overlayStamp === stamp && this.overlayKeyer.canvas.width > 0) keyed = this.overlayKeyer.canvas;
        else {
          keyed = this.overlayKeyer.process(v, l.chroma);
          this.overlayStamp = keyed ? stamp : '';
        }
      }
      if (l.alpha >= 1 && w < canvas.w - 1 && !keyed) {
        ctx.fillStyle = '#000';
        ctx.fillRect(dx, 0, canvas.w, canvas.h);
      }
      try {
        ctx.drawImage(keyed ?? v, dx + (canvas.w - w) / 2, (canvas.h - h) / 2, w, h);
      } catch {
        // Quadro indisponível por um instante.
      }
      if (!v.paused) fresh = true;
    }
    if (overlay && overlay.black > 0) {
      ctx.globalAlpha = Math.min(1, overlay.black);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.w, canvas.h);
      fresh = true;
    }
    ctx.globalAlpha = 1;
    if (fresh) this.drawnCount++;
    const now = performance.now();
    if (now - this.drawnSince >= 1000) {
      this.drawnFps = Math.round((this.drawnCount * 1000) / (now - this.drawnSince));
      this.drawnCount = 0;
      this.drawnSince = now;
    }
  }
}
