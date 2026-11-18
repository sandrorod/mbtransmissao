/** Trilhas que na verdade vêm de um vídeo de arquivo (área Mídias): o leitor usa o próprio vídeo. */
const directVideos = new WeakMap<MediaStreamTrack, HTMLVideoElement>();
export const registerDirectVideo = (track: MediaStreamTrack, video: HTMLVideoElement) => directVideos.set(track, video);
const directVideoFor = (track: MediaStreamTrack) => directVideos.get(track) ?? null;

/** Contêiner dos vídeos que alimentam o programa: dentro da tela (1 px, quase invisível), nunca fora dela. */
export function holder(): HTMLElement {
  let node = document.getElementById('program-sources');
  if (!node) {
    node = document.createElement('div');
    node.id = 'program-sources';
    node.setAttribute('aria-hidden', 'true');
    // Fora da área visível o Chromium "economiza" o vídeo e ele atualiza aos trancos; com 1 px visível, não.
    Object.assign(node.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', overflow: 'hidden', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(node);
  }
  return node;
}

/**
 * Entrega o quadro mais recente de uma trilha de vídeo para o compositor desenhar.
 * Usa um elemento <video> (caminho que mantém o gravador da transmissão e as câmeras estáveis);
 * guardar os quadros brutos da câmera esgota a memória de vídeo e trava o gravador.
 */
export class FrameReader {
  readonly video: HTMLVideoElement;
  /** Muda a cada quadro novo exibido (para medir a fluidez real). */
  frames = 0;
  /** Chamado a cada quadro novo (o compositor desenha na hora em que a imagem chega). */
  onFrame: (() => void) | null = null;
  private stopped = false;
  /** Vídeo da área Mídias: desenhado direto do tocador (o elemento é dele; aqui só se lê). */
  private direct = false;

  constructor(readonly track: MediaStreamTrack) {
    const own = directVideoFor(track);
    if (own) {
      // Sem captura no meio: o compositor desenha o próprio vídeo do arquivo (uma decodificação a menos, sem trancos).
      this.direct = true;
      this.video = own;
      const tick = () => {
        if (this.stopped) return;
        this.frames++;
        this.onFrame?.();
        own.requestVideoFrameCallback(tick);
      };
      own.requestVideoFrameCallback(tick);
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.width = 320;
    video.height = 180;
    video.srcObject = new MediaStream([track]);
    holder().appendChild(video);
    void video.play().catch(() => undefined);
    this.video = video;
    const tick = () => {
      if (this.stopped) return;
      this.frames++;
      this.onFrame?.();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  /** O vídeo pronto para desenhar, ou null enquanto não chegou imagem. */
  get latest(): HTMLVideoElement | null {
    return this.video.readyState >= 2 && this.video.videoWidth > 0 ? this.video : null;
  }

  stop(): void {
    this.stopped = true;
    if (this.direct) return;
    this.video.srcObject = null;
    this.video.remove();
  }
}
