import { useSyncExternalStore } from 'react';
import { DEFAULT_TRANSITION, type ReplayClip, type ReplayFolder, type ReplayIntro, type ReplayPatch, type ReplayTransition, type VignetteKind } from '../types/studio';
import type { Compositor, OverlayFrame } from './compositor';
import { holder } from './frames';

/** Id das vinhetas na fila (os replays usam o nome do arquivo). */
export const INTRO_ID = 'abertura';
export const OUTRO_ID = 'saida';
export const isVignette = (id: string | null) => id === INTRO_ID || id === OUTRO_ID;

export interface ReplayState {
  clips: ReplayClip[];
  folders: ReplayFolder[];
  /** No ar agora: id do replay, INTRO_ID/OUTRO_ID (vinhetas) ou null (programa normal). */
  playing: string | null;
  /** Replays que ainda vão passar depois do atual. */
  queue: string[];
}

/** Um vídeo da sequência: a abertura ou um replay, já com o corte (em segundos do vídeo). */
interface Step {
  id: string;
  url: string;
  start: number;
  end: number | null;
  /** Vinheta de entrada ou de saída (som e fundo removido são dela). */
  vignette?: ReplayIntro;
}

interface Running {
  step: Step;
  video: HTMLVideoElement;
}

type Phase = 'in' | 'play' | 'cross' | 'out';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

/** Onde cada vídeo aparece num instante da transição (p vai de 0 a 1). Separado para dar para testar. */
export function transitionFrame(kind: ReplayTransition['kind'], phase: Phase, p: number, cur: HTMLVideoElement, next: HTMLVideoElement | null): OverlayFrame {
  const at = (video: HTMLVideoElement, alpha: number, x = 0) => ({ video, alpha, x });
  if (phase === 'play' || kind === 'corte') return { layers: [at(cur, 1)], black: 0 };
  if (phase === 'in') {
    if (kind === 'fade') return { layers: [at(cur, p)], black: 0 };
    if (kind === 'deslizar') return { layers: [at(cur, 1, 1 - p)], black: 0 };
    // Preto: a cena escurece e o replay aparece do preto.
    return p < 0.5 ? { layers: [], black: p * 2 } : { layers: [at(cur, 1)], black: (1 - p) * 2 };
  }
  if (phase === 'out') {
    if (kind === 'fade') return { layers: [at(cur, 1 - p)], black: 0 };
    if (kind === 'deslizar') return { layers: [at(cur, 1, -p)], black: 0 };
    return p < 0.5 ? { layers: [at(cur, 1)], black: p * 2 } : { layers: [], black: (1 - p) * 2 };
  }
  // Entre dois vídeos.
  if (!next) return { layers: [at(cur, 1)], black: 0 };
  if (kind === 'fade') return { layers: [at(cur, 1), at(next, p)], black: 0 };
  if (kind === 'deslizar') return { layers: [at(cur, 1, -p), at(next, 1, 1 - p)], black: 0 };
  return p < 0.5 ? { layers: [at(cur, 1)], black: p * 2 } : { layers: [at(next, 1)], black: (1 - p) * 2 };
}

/**
 * Replays: lista dos cortes (com pastas) e a exibição no Programa. Os vídeos tocam em elementos fora da tela e o
 * compositor os desenha por cima da cena (vai para a transmissão). Cada exibição começa pela abertura (se houver)
 * e passa os replays com a transição escolhida; no fim volta para a cena.
 * Replays vão sem som; a abertura pode levar o som dela para o programa (onIntroAudio).
 */
export class ReplayPlayer {
  private state: ReplayState = { clips: [], folders: [], playing: null, queue: [] };
  private listeners = new Set<() => void>();
  private urls = new Map<string, string>();
  private token = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intro: ReplayIntro | null = null;
  private outro: ReplayIntro | null = null;
  private vignetteUrls = new Map<VignetteKind, { key: string; url: string }>();
  private transition: ReplayTransition = DEFAULT_TRANSITION;
  /** Velocidade dos replays (câmera lenta). As vinhetas tocam sempre em 1x. */
  private speed = 1;

  // Sequência no ar.
  private steps: Step[] = [];
  private index = 0;
  private cur: Running | null = null;
  private next: Running | null = null;
  private phase: Phase = 'play';
  private phaseStart = 0;
  private phaseMs = 0;

  /** Som da abertura: stream para entrar no mixer do programa (null = tirar). */
  onIntroAudio: (stream: MediaStream | null) => void = () => undefined;

  constructor(private compositor: Compositor, private onError: (message: string) => void) {}

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getState = () => this.state;

  private set(patch: Partial<ReplayState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((cb) => cb());
  }

  configure(intro: ReplayIntro | null, outro: ReplayIntro | null, transition: ReplayTransition): void {
    this.intro = intro;
    this.outro = outro;
    this.transition = transition;
    for (const [kind, v] of [['entrada', intro], ['saida', outro]] as const) {
      const cached = this.vignetteUrls.get(kind);
      if (cached && cached.key !== (v ? `${v.ext}|${v.name}` : '')) {
        URL.revokeObjectURL(cached.url);
        this.vignetteUrls.delete(kind);
      }
      // Já deixa o arquivo carregado: no primeiro replay a vinheta entra sem esperar a leitura do disco.
      if (v) void this.vignetteStep(kind).catch(() => undefined);
    }
  }

  /** Muda a velocidade dos replays; vale na hora para o replay no ar e o próximo já carregado (não para vinhetas). */
  setSpeed(speed: number): void {
    this.speed = speed > 0 ? speed : 1;
    for (const run of [this.cur, this.next]) if (run) this.applyRate(run);
  }

  private applyRate(run: Running): void {
    const rate = run.step.vignette ? 1 : this.speed;
    run.video.defaultPlaybackRate = rate;
    run.video.playbackRate = rate;
  }

  /** Tempo real (ms) que falta tocar de um trecho do vídeo, considerando a velocidade. */
  private realMs(run: Running, videoSeconds: number): number {
    return (videoSeconds * 1000) / (run.video.playbackRate || 1);
  }

  async refresh(): Promise<void> {
    const [clips, folders] = await Promise.all([window.studio.replayList(), window.studio.replayFolders()]);
    this.set({ clips, folders });
  }

  /** Corte novo: entra no topo da lista e já fica carregado (para entrar no ar sem espera). */
  add(clip: ReplayClip): void {
    this.set({ clips: [clip, ...this.state.clips.filter((c) => c.id !== clip.id)] });
    void this.url(clip.id).catch(() => undefined);
  }

  async update(id: string, patch: ReplayPatch): Promise<void> {
    // Na tela na hora; o disco confirma (e corrige, se algo não valer).
    this.set({ clips: this.state.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    try {
      this.set({ clips: await window.studio.replayUpdate(id, patch) });
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
      void this.refresh();
    }
  }

  /** Mesma mudança em vários replays (ex.: arrastar os marcados para uma pasta), gravados um de cada vez. */
  async updateMany(ids: string[], patch: ReplayPatch): Promise<void> {
    if (ids.length === 0) return;
    this.set({ clips: this.state.clips.map((c) => (ids.includes(c.id) ? { ...c, ...patch } : c)) });
    try {
      let clips = this.state.clips;
      // Um por vez: o arquivo da biblioteca é lido e regravado a cada mudança.
      for (const id of ids) clips = await window.studio.replayUpdate(id, patch);
      this.set({ clips });
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
      void this.refresh();
    }
  }

  async saveFolders(folders: ReplayFolder[]): Promise<void> {
    const removed = new Set(this.state.folders.filter((f) => !folders.some((x) => x.id === f.id)).map((f) => f.id));
    this.set({ folders, clips: this.state.clips.map((c) => (c.folder && removed.has(c.folder) ? { ...c, folder: null } : c)) });
    try {
      this.set({ folders: await window.studio.replaySaveFolders(folders) });
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
      void this.refresh();
    }
  }

  /** Endereço local do vídeo do replay (para tocar no programa ou na edição). */
  async url(id: string): Promise<string> {
    const cached = this.urls.get(id);
    if (cached) return cached;
    const bytes = await window.studio.replayRead(id);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
    this.urls.set(id, url);
    return url;
  }

  private async vignetteStep(kind: VignetteKind): Promise<Step | null> {
    const v = kind === 'entrada' ? this.intro : this.outro;
    if (!v) return null;
    const key = `${v.ext}|${v.name}`;
    let cached = this.vignetteUrls.get(kind);
    if (!cached || cached.key !== key) {
      const bytes = await window.studio.replayIntroRead(kind, v.ext);
      cached = { key, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[v.ext] ?? 'video/mp4' })) };
      this.vignetteUrls.set(kind, cached);
    }
    return { id: kind === 'entrada' ? INTRO_ID : OUTRO_ID, url: cached.url, start: v.start, end: v.end > 0 ? v.end : null, vignette: v };
  }

  /** Coloca no ar, do mais recente para o mais antigo, com a abertura antes. */
  play(ids: string[]): void {
    // Do corte mais recente para o mais antigo; no mesmo corte, o Programa e depois cada câmera.
    const order = this.state.clips.filter((c) => ids.includes(c.id)).sort((a, b) => b.createdAt - a.createdAt || Number(Boolean(a.source)) - Number(Boolean(b.source)) || (a.source ?? '').localeCompare(b.source ?? ''));
    if (order.length === 0) return;
    const fromScene = this.cur === null;
    this.halt();
    const token = ++this.token;
    this.set({ playing: order[0].id, queue: order.slice(1).map((c) => c.id) });
    void (async () => {
      const steps: Step[] = [];
      const vignette = async (kind: VignetteKind) => {
        try {
          const step = await this.vignetteStep(kind);
          if (step) steps.push(step);
        } catch {
          this.onError(`A vinheta de ${kind === 'entrada' ? 'entrada' : 'saída'} não foi encontrada neste computador. Importe de novo em Configurações › Replay › Vinhetas.`);
        }
      };
      await vignette('entrada');
      for (const clip of order) {
        try {
          steps.push({ id: clip.id, url: await this.url(clip.id), start: clip.start ?? 0, end: clip.end ?? null });
        } catch (e) {
          this.onError(e instanceof Error ? e.message : String(e));
        }
      }
      await vignette('saida');
      if (token !== this.token) return;
      if (steps.length === 0) {
        this.stop();
        return;
      }
      this.steps = steps;
      this.index = 0;
      const first = await this.load(steps[0], token);
      if (token !== this.token) return;
      if (!first) {
        this.skipBroken(token);
        return;
      }
      this.cur = first;
      // A abertura entra direto por cima da imagem do Programa (sem transição); um replay sozinho entra com ela.
      this.begin(first, fromScene && first.step.id !== INTRO_ID ? 'in' : 'play');
      this.compositor.setOverlay(() => this.frame());
      this.timer = setInterval(() => this.tick(token), 40);
      void this.preload(token);
    })();
  }

  /** Vídeo que não abriu: segue com o próximo da lista. */
  private skipBroken(token: number): void {
    this.steps = this.steps.slice(1);
    if (this.steps.length === 0 || token !== this.token) {
      this.stop();
      return;
    }
    void (async () => {
      const v = await this.load(this.steps[0], token);
      if (token !== this.token) return;
      if (!v) return this.skipBroken(token);
      this.cur = v;
      this.begin(v, 'in');
      this.compositor.setOverlay(() => this.frame());
      this.timer = setInterval(() => this.tick(token), 40);
      void this.preload(token);
    })();
  }

  private async load(step: Step, token: number): Promise<Running | null> {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.width = 320;
    video.height = 180;
    video.src = step.url;
    // Dentro da página (cantinho de 1 px): fora dela o Chromium economiza o vídeo e a vinheta/replay
    // tocava aos trancos, parecendo lenta (mesma causa das travadas das Mídias).
    holder().appendChild(video);
    const ok = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 8000);
      video.onloadeddata = () => { clearTimeout(timeout); resolve(true); };
      video.onerror = () => { clearTimeout(timeout); resolve(false); };
    });
    if (ok && step.start > 0 && step.start < (video.duration || Infinity)) {
      video.currentTime = step.start;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        video.onseeked = () => { clearTimeout(timeout); resolve(); };
      });
    }
    if (!ok || token !== this.token) {
      if (!ok) this.onError(step.vignette ? 'Não deu para tocar a vinheta.' : 'Não deu para tocar este replay.');
      this.dispose(video);
      return null;
    }
    const run = { step, video };
    this.applyRate(run);
    return run;
  }

  /** Deixa o próximo vídeo carregado e parado no ponto de início (a transição começa sem espera). */
  private async preload(token: number): Promise<void> {
    const step = this.steps[this.index + 1];
    if (!step || this.next) return;
    const next = await this.load(step, token);
    if (token !== this.token) return;
    if (next) this.next = next;
    else {
      // Não abriu: tira da sequência e tenta o seguinte.
      this.steps.splice(this.index + 1, 1);
      void this.preload(token);
    }
  }

  private begin(run: Running, phase: Phase): void {
    this.applyRate(run);
    void run.video.play().catch(() => undefined);
    this.enter(phase);
    this.set({ playing: run.step.id, queue: this.steps.slice(this.index + 1).filter((s) => !s.vignette).map((s) => s.id) });
    if (!run.step.vignette?.sound) {
      this.onIntroAudio(null);
      return;
    }
    // A faixa de som da captura só existe depois que o vídeo começa a tocar.
    const connect = () => { if (this.cur?.video === run.video) this.onIntroAudio(captureAudio(run.video)); };
    if (!run.video.paused && run.video.readyState >= 3) connect();
    else run.video.addEventListener('playing', connect, { once: true });
  }

  /** Duração da transição: nunca mais que metade do vídeo mais curto envolvido. */
  private transitionMs(...videos: (Running | null)[]): number {
    if (this.transition.kind === 'corte') return 0;
    const lengths = videos.filter((v): v is Running => v !== null).map((v) => this.realMs(v, (v.step.end ?? v.video.duration) - v.step.start)).filter((ms) => Number.isFinite(ms) && ms > 0);
    return Math.min(this.transition.ms, ...lengths.map((ms) => ms / 2));
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.phaseStart = performance.now();
    this.phaseMs = phase === 'play' ? 0 : phase === 'cross' ? this.transitionMs(this.cur, this.next) : this.transitionMs(this.cur);
  }

  private tick(token: number): void {
    const cur = this.cur;
    if (token !== this.token || !cur) return;
    const elapsed = performance.now() - this.phaseStart;
    const end = cur.step.end ?? cur.video.duration;
    // Corte do fim: segura o último quadro.
    if (Number.isFinite(end) && cur.video.currentTime >= end && !cur.video.paused) cur.video.pause();
    // Em tempo real: em câmera lenta o mesmo trecho do vídeo dura mais
    const remainingMs = Number.isFinite(end) ? this.realMs(cur, end - cur.video.currentTime) : Infinity;
    const last = this.index >= this.steps.length - 1;
    // Vinheta de saída no fim: passa inteira e corta direto para a cena (ela mesma é a transição).
    if (last && cur.step.id === OUTRO_ID) {
      if (this.phase === 'in' && elapsed >= this.phaseMs) this.enter('play');
      if (cur.video.ended || remainingMs <= 20) this.stop();
      return;
    }
    const finishing = cur.video.ended || remainingMs <= this.transitionMs(cur, this.next) + 20;

    if (this.phase === 'in' && elapsed >= this.phaseMs) this.enter('play');
    if ((this.phase === 'play' || this.phase === 'in') && finishing) {
      if (this.index < this.steps.length - 1) {
        // Próximo ainda carregando: segura o quadro atual até ele ficar pronto.
        if (this.next) {
          void this.next.video.play().catch(() => undefined);
          this.enter('cross');
        }
      } else this.enter('out');
      return;
    }
    if (this.phase === 'cross' && elapsed >= this.phaseMs && this.next) {
      const old = cur;
      this.cur = this.next;
      this.next = null;
      this.index += 1;
      this.dispose(old.video);
      this.begin(this.cur, 'play');
      void this.preload(token);
      return;
    }
    if (this.phase === 'out' && elapsed >= this.phaseMs) this.stop();
  }

  private frame(): OverlayFrame {
    if (!this.cur) return { layers: [], black: 0 };
    const p = this.phaseMs > 0 ? clamp01((performance.now() - this.phaseStart) / this.phaseMs) : 1;
    const frame = transitionFrame(this.transition.kind, this.phase, p, this.cur.video, this.next?.video ?? null);
    // Vinheta com fundo removido: a cena (ou o replay) continua aparecendo por baixo dela.
    for (const run of [this.cur, this.next]) {
      const chroma = run?.step.vignette?.chroma;
      if (run && chroma?.enabled) frame.layers = frame.layers.map((l) => (l.video === run.video ? { ...l, chroma } : l));
    }
    return frame;
  }

  private dispose(video: HTMLVideoElement): void {
    video.onloadeddata = null;
    video.onerror = null;
    video.onseeked = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }

  /** Para tudo sem mexer no estado da tela (usado ao trocar de sequência). */
  private halt(): void {
    this.token++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cur) this.dispose(this.cur.video);
    if (this.next) this.dispose(this.next.video);
    this.cur = null;
    this.next = null;
    this.steps = [];
    this.index = 0;
    this.onIntroAudio(null);
  }

  /** Volta o programa para a cena. */
  stop(): void {
    this.halt();
    this.compositor.setOverlay(null);
    this.set({ playing: null, queue: [] });
  }

  /** Apaga vários de uma vez (um arquivo por vez no disco; a lista atualiza no fim). */
  async removeMany(ids: string[]): Promise<void> {
    if (this.state.playing && ids.includes(this.state.playing)) this.stop();
    let clips = this.state.clips;
    try {
      for (const id of ids) {
        const url = this.urls.get(id);
        if (url) URL.revokeObjectURL(url);
        this.urls.delete(id);
        clips = await window.studio.replayDelete(id);
      }
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
      void this.refresh();
      return;
    }
    this.set({ clips, queue: this.state.queue.filter((q) => !ids.includes(q)) });
  }

  async remove(id: string): Promise<void> {
    if (this.state.playing === id) this.stop();
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.set({ clips: await window.studio.replayDelete(id), queue: this.state.queue.filter((q) => q !== id) });
  }
}

/** Som do vídeo como stream (o elemento fica mudo para não tocar no alto-falante; a captura não é afetada). */
function captureAudio(video: HTMLVideoElement): MediaStream | null {
  const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
  if (!capture) return null;
  try {
    const tracks = capture.call(video).getAudioTracks();
    return tracks.length > 0 ? new MediaStream(tracks) : null;
  } catch {
    return null;
  }
}

export function useReplay(player: ReplayPlayer): ReplayState {
  return useSyncExternalStore(player.subscribe, player.getState);
}
