import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Crop, Expand, Square, Eye, EyeOff, Hand, LocateFixed, LockKeyhole, ThumbsUp, Maximize, MessageSquare, Minimize, Shrink, Users, Wifi, ZoomIn, ZoomOut } from 'lucide-react';
import { displayName } from '../devices/identify';
import { usePooledStream } from '../devices/pool';
import { centerTransform, contentZoom, extendRegion, fillTransform, panRegion, placement, setContentZoom, snapToCenterX, snapToCenterY, toTransform, visibleArea, zoomRegion, type Compositor, type Rect } from '../program/compositor';
import { BORDER_STYLES, DEFAULT_BORDER, NO_CROP, type Border, type BorderStyle, type LiveExtras, type MediaLook, type LiveStatus, type OutputSettings, type ProgramHud, type SceneItem, type Source, type Transform, type WebPage } from '../types/studio';
import { useLiveMetrics } from '../program/liveStore';
import { videoSpecOf } from './DevicesPanel';

/** Abre a fonte e entrega a trilha de vídeo ao compositor, que lê cada quadro direto dela. */
function LayerTrack({ source, register }: { source: Source; register: (id: string, track: MediaStreamTrack | null, status: string) => void }) {
  const pooled = usePooledStream(videoSpecOf(source));
  const track = pooled.stream?.getVideoTracks()[0] ?? null;
  useEffect(() => {
    register(source.id, track, pooled.status);
  }, [source.id, track, pooled.status, register]);
  useEffect(() => () => register(source.id, null, 'parado'), [source.id, register]);
  return null;
}

type Handle = 'move' | 'content' | 'nw' | 'ne' | 'sw' | 'se' | 'l' | 'r' | 't' | 'b';

interface Drag {
  handle: Handle;
  id: string;
  start: { x: number; y: number };
  t0: Transform;
  rect0: Rect;
  /** Arrastando o conteúdo de um widget: a área da página no começo. */
  region0?: Rect | null;
  pageId?: string;
}

const MIN_PX = 24;

type Level = 'boa' | 'media' | 'ruim' | 'off';

/**
 * Qualidade da conexão: junta o que o Mac mede (velocidade do envio, quadros e taxa reais) com o que o
 * YouTube diz do sinal que chega lá. Vale o pior dos dois.
 */
export function connectionQuality(live: LiveStatus | null, output: OutputSettings, extras: LiveExtras | null): { level: Level; label: string; details: string[] } {
  if (!live) return { level: 'off', label: 'Fora do ar', details: ['A qualidade aparece durante a transmissão.'] };
  if (live.state === 'iniciando') return { level: 'media', label: 'Conectando…', details: [live.message ?? 'Abrindo a conexão com as plataformas.'] };
  if (live.state === 'reconectando') return { level: 'ruim', label: 'Reconectando', details: [live.message ?? 'A conexão caiu; tentando de novo.'] };
  if (live.state !== 'ao-vivo') return { level: 'ruim', label: 'Parada', details: [live.message ?? ''] };
  const rank: Record<Level, number> = { off: 0, boa: 1, media: 2, ruim: 3 };
  // Cada problema diz de onde vem: internet, computador ou YouTube. O rótulo mostra a causa do pior.
  let worst: { level: Level; cause: 'internet' | 'computador' | 'youtube' | null } = { level: 'boa', cause: null };
  const details: string[] = [];
  const flag = (level: Level, cause: 'internet' | 'computador' | 'youtube', why: string) => {
    if (rank[level] > rank[worst.level]) worst = { level, cause };
    details.push(why);
  };
  const mbps = (live.kbps / 1000).toFixed(1).replace('.', ',');
  details.push(`Enviando ${mbps} Mbps · programa a ${Math.round(live.fps)} quadros/s${live.speed ? ` · velocidade do envio ${live.speed.toFixed(2).replace('.', ',')}x` : ''}`);
  // Internet: a velocidade dos últimos segundos abaixo de 1 = o envio está atrasando.
  if (live.speed !== undefined && live.speed > 0) {
    if (live.speed < 0.85) flag('ruim', 'internet', 'O envio está atrasando: a internet (upload) não está dando conta. Diminua a qualidade.');
    else if (live.speed < 0.95) flag('media', 'internet', 'O envio está no limite do upload da internet.');
  }
  if (live.destinations.some((d) => !d.ok)) flag('ruim', 'internet', `Falha em: ${live.destinations.filter((d) => !d.ok).map((d) => d.name).join(', ')}.`);
  // Computador: o programa gerando menos quadros que o pedido (média dos últimos ~10 s).
  if (live.fps > 0 && live.fps < output.fps * 0.5) flag('ruim', 'computador', `O computador está sobrecarregado: o programa sai a ${Math.round(live.fps)} de ${output.fps} quadros/s. Feche outros programas ou diminua a qualidade.`);
  else if (live.fps > 0 && live.fps < output.fps * 0.75) flag('media', 'computador', `O computador está no limite: programa a ${Math.round(live.fps)} de ${output.fps} quadros/s.`);
  // YouTube: "ok" é aceitável (só avisa); ruim ou sem sinal pesam.
  const health = extras?.health;
  if (health === 'bad') flag('ruim', 'youtube', 'O YouTube diz que o sinal que chega lá está ruim.');
  else if (health === 'noData') flag('ruim', 'youtube', 'O YouTube não está recebendo o vídeo.');
  else if (health === 'ok') details.push('O YouTube diz que o sinal está aceitável.');
  else if (health === 'good') details.push('O YouTube diz que o sinal está bom.');
  for (const issue of extras?.issues ?? []) details.push(`YouTube: ${issue}`);
  const level = worst.level;
  const label = level === 'boa' ? 'Conexão boa'
    : worst.cause === 'computador' ? (level === 'ruim' ? 'Computador sobrecarregado' : 'Computador no limite')
      : worst.cause === 'youtube' ? (level === 'ruim' ? 'YouTube: sinal ruim' : 'YouTube: sinal instável')
        : level === 'ruim' ? 'Internet ruim' : 'Internet instável';
  return { level, label, details };
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};

/** Comentários do chat ao vivo do YouTube, sempre rolando para o mais novo (a não ser que o operador suba). */
/** Indicador de conexão: lê os números da live direto do liveStore (só ele redesenha a cada atualização). */
function QualityChip({ live, output, extras }: { live: LiveStatus | null; output: OutputSettings; extras: LiveExtras | null }) {
  const metrics = useLiveMetrics();
  const now = live && metrics && metrics.state === live.state ? metrics : live;
  const q = connectionQuality(now, output, extras);
  return (
    <span className={`hud-chip hud-${q.level}`} data-tip={q.details.join('\n')} data-tip-wide="">
      <i className="hud-dot" /> {q.label}
      {now?.state === 'ao-vivo' && now.kbps > 0 && <small>{(now.kbps / 1000).toFixed(1).replace('.', ',')} Mbps</small>}
    </span>
  );
}

function LiveChat({ extras }: { extras: LiveExtras | null }) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const chat = extras?.chat ?? [];
  useLayoutEffect(() => {
    const node = list.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [chat.length]);
  const empty = !extras ? 'Os comentários aparecem durante a transmissão.' : extras.error ?? extras.chatError ?? (chat.length === 0 ? 'Nenhum comentário ainda.' : null);
  return (
    <aside className="live-chat" aria-label="Comentários ao vivo">
      <header className="live-chat-head"><MessageSquare size={13} /> Comentários ao vivo</header>
      <div className="live-chat-list" ref={list} onScroll={(e) => { const n = e.currentTarget; stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 40; }}>
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.amount ? 'chat-msg-super' : ''}`}>
            {m.avatar ? <img className="chat-avatar" src={m.avatar} alt="" referrerPolicy="no-referrer" /> : <span className="chat-avatar" />}
            <div className="chat-body">
              <span className={`chat-author ${m.role ? `chat-${m.role}` : ''}`}>{m.author}</span>
              <span className="chat-time">{timeOf(m.at)}</span>
              {m.amount && <span className="chat-amount">{m.amount}</span>}
              <p className="chat-text">{m.text}</p>
            </div>
          </div>
        ))}
        {empty && <p className="chat-empty">{empty}</p>}
      </div>
    </aside>
  );
}
/** Cores prontas da borda (a última escolha livre fica no seletor de cor). */
const BORDER_COLORS = ['#ffffff', '#000000', '#f5a524', '#e5484d', '#30a46c', '#0090ff', '#8e4ec6', '#ffe629'];

/** Botão "Borda": liga/desliga e escolhe o tipo, a cor, a espessura e os cantos da borda da fonte selecionada. */
function BorderMenu({ border, disabled, onChange }: { border: Border | null; disabled: boolean; onChange: (border: Border | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = border ?? DEFAULT_BORDER;
  const set = (patch: Partial<Border>) => onChange({ ...current, ...patch });
  return (
    <div className="border-menu" ref={ref}>
      <button type="button" className={`btn btn-small ${border ? 'btn-on' : ''}`} disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)} data-tip="Borda em volta desta fonte">
        <Square size={13} /> {border ? `Borda: ${BORDER_STYLES[border.style]}` : 'Borda'}
      </button>
      {open && (
        <div className="menu border-pop" role="dialog" aria-label="Borda">
          <label className="border-row">
            <span>Tipo</span>
            <select value={border ? border.style : 'nenhuma'} onChange={(e) => (e.target.value === 'nenhuma' ? onChange(null) : set({ style: e.target.value as BorderStyle }))}>
              <option value="nenhuma">Sem borda</option>
              {(Object.entries(BORDER_STYLES) as [BorderStyle, string][]).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <div className="border-row">
            <span>Cor</span>
            <span className="border-colors">
              {BORDER_COLORS.map((c) => (
                <button key={c} type="button" className={`border-color ${border && current.color.toLowerCase() === c ? 'border-color-on' : ''}`} style={{ background: c }} aria-label={`Cor ${c}`} onClick={() => set({ color: c })} />
              ))}
              <input type="color" value={current.color} aria-label="Outra cor" onChange={(e) => set({ color: e.target.value })} />
            </span>
          </div>
          <label className="border-row">
            <span>Espessura</span>
            <input type="range" min={1} max={40} step={1} value={current.width} onChange={(e) => set({ width: Number(e.target.value) })} />
            <output>{current.width}</output>
          </label>
          <label className="border-row">
            <span>Cantos</span>
            <input type="range" min={0} max={200} step={2} value={current.radius} onChange={(e) => set({ radius: Number(e.target.value) })} />
            <output>{current.radius === 0 ? 'retos' : current.radius}</output>
          </label>
          {border && <button type="button" className="btn btn-small" onClick={() => { onChange(null); setOpen(false); }}>Tirar a borda</button>}
        </div>
      )}
    </div>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Estilo de cada mídia (pelo id de dispositivo "midia:<id>"): a borda dele e o resto (cantos, sombra, efeitos). */
export type MediaStyles = Map<string, { border: Border | null; look: MediaLook }>;

/** Tela (Programa ou Prévia) em que se clicou por último: só ela responde às setas. Nenhuma ainda = o Programa. */
let arrowsOwner: object | null = null;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

interface Props {
  compositor: Compositor;
  items: SceneItem[];
  sources: Source[];
  pages: WebPage[];
  selectedId: string | null;
  onSelect: (sourceId: string | null) => void;
  onTransform: (sourceId: string, transform: Transform | null) => void;
  onToggleHidden: (sourceId: string) => void;
  onPageRegion: (pageId: string, region: WebPage['region']) => void;
  /** Situação da transmissão (null fora do ar). */
  live: LiveStatus | null;
  output: OutputSettings;
  extras: LiveExtras | null;
  hud: ProgramHud;
  onHud: (hud: ProgramHud) => void;
  /** Fontes com cadeado fechado na cena (delas ou da pasta): não saem do lugar. */
  lockedIds: Set<string>;
  /** Preenche a tela com a fonte (ou volta para onde ela estava). */
  onToggleFill: (sourceId: string) => void;
  /** Liga, troca ou tira (null) a borda da fonte. */
  onBorder?: (sourceId: string, border: Border | null) => void;
  /** Prévia: as mesmas ferramentas, sem os indicadores da transmissão nem o "Ocultar". */
  editor?: boolean;
  /** Só a imagem (Prévia no layout): sem barra de ferramentas nem alças. */
  viewOnly?: boolean;
  /** Prévia: tira a fonte selecionada da prévia. */
  onRemove?: (sourceId: string) => void;
  /** Estilo das mídias (borda, cantos, sombra, efeitos). */
  mediaStyles?: MediaStyles;
}

/** Programa: a imagem real que vai ao ar, com as alças para posicionar, redimensionar e cortar cada fonte. */
export function ProgramView({ compositor, items, sources, pages, selectedId, onSelect, onTransform, onToggleHidden, onPageRegion, live, output, extras, hud, onHud, lockedIds, onToggleFill, onBorder, editor = false, viewOnly = false, onRemove, mediaStyles }: Props) {
  /** Modo "mover conteúdo": arrastar dentro do widget anda com a página, não com a moldura. */
  const [contentMode, setContentMode] = useState(false);
  /** Linhas do centro: aparecem enquanto o centro da fonte arrastada está alinhado ao centro da tela (x = linha em pé, y = deitada). */
  const [centerGuide, setCenterGuide] = useState({ x: false, y: false });
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const videos = useRef(new Map<string, { track: MediaStreamTrack | null; status: string }>());
  const drag = useRef<Drag | null>(null);
  const [, setTick] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const canvas = compositor.size;
  const videoItems = items.filter((i) => sources.find((s) => s.id === i.sourceId)?.kind === 'video');
  const sourceOf = (id: string) => sources.find((s) => s.id === id)!;

  const register = useRef((id: string, track: MediaStreamTrack | null, status: string) => {
    videos.current.set(id, { track, status });
    setTick((t) => t + 1);
  }).current;
  const pageOf = (source: Source) => (source.device.deviceId.startsWith('pagina:') ? pages.find((p) => `pagina:${p.id}` === source.device.deviceId) ?? null : null);

  // Camadas na ordem da cena: a primeira fica atrás.
  useEffect(() => {
    compositor.setLayers(videoItems.map((item) => {
      const source = sourceOf(item.sourceId);
      const page = pageOf(source);
      // Mídia: a borda posta no Programa (menu Borda) vale mais que a do estilo da mídia.
      const style = mediaStyles?.get(source.device.deviceId);
      return { id: item.sourceId, track: videos.current.get(item.sourceId)?.track ?? null, settings: source.video, transform: item.transform, hidden: item.hidden, region: page?.region ?? null, chroma: page?.chroma ?? null, border: item.border ?? style?.border ?? null, look: style?.look ?? null };
    }));
  });

  // O canvas do compositor é o próprio vídeo do programa: ele é colocado aqui dentro.
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    node.appendChild(compositor.canvas);
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const aspect = compositor.canvas.width / compositor.canvas.height;
      setBox(width / height > aspect ? { w: height * aspect, h: height } : { w: width, h: width / aspect });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (compositor.canvas.parentNode === node) node.removeChild(compositor.canvas);
    };
  }, [compositor]);

  // O canvas tem o tamanho real da transmissão; na tela ele é mostrado do tamanho do quadro.
  useEffect(() => {
    compositor.canvas.style.width = `${box.w}px`;
    compositor.canvas.style.height = `${box.h}px`;
  }, [box, compositor]);

  // Os tamanhos das fontes chegam depois que o vídeo começa: redesenha as alças de tempos em tempos.
  useEffect(() => {
    // Só redesenha quando algum tamanho mudou (antes redesenhava 2×/s mesmo sem mudança, durante a live).
    let last = '';
    const timer = setInterval(() => {
      const now = [...compositor.sizes].map(([id, s]) => `${id}:${s.w}x${s.h}`).join('|');
      if (now === last) return;
      last = now;
      setTick((t) => t + 1);
    }, 500);
    return () => clearInterval(timer);
  }, [compositor]);

  const rectOf = (item: SceneItem): Rect | null => {
    const frame = compositor.sizes.get(item.sourceId);
    if (!frame) return null;
    const source = sourceOf(item.sourceId);
    return placement(visibleArea(frame, source.video, item.transform?.crop, pageOf(source)?.region ?? null), item.transform, canvas);
  };

  const toCanvas = (event: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: ((event.clientX - r.left) / r.width) * canvas.w, y: ((event.clientY - r.top) / r.height) * canvas.h };
  };

  const begin = (event: ReactPointerEvent<HTMLElement>, item: SceneItem, handle: Handle) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect(item.sourceId);
    // Fonte com cadeado fechado: nem recebe o clique no Programa (pointer-events: none); trava por garantia.
    if (lockedIds.has(item.sourceId)) return;
    const frame = compositor.sizes.get(item.sourceId);
    const rect0 = rectOf(item);
    if (!frame || !rect0) return;
    const settings = sourceOf(item.sourceId).video;
    const page = pageOf(sourceOf(item.sourceId));
    if (handle === 'move' && page && (contentMode || event.altKey)) {
      overlay.current!.setPointerCapture(event.pointerId);
      drag.current = { handle: 'content', id: item.sourceId, start: toCanvas(event), t0: item.transform ?? toTransform(rect0, canvas), rect0, region0: page.region, pageId: page.id };
      return;
    }
    const t0 = item.transform ?? toTransform(placement(visibleArea(frame, settings, undefined, pageOf(sourceOf(item.sourceId))?.region ?? null), null, canvas), canvas);
    overlay.current!.setPointerCapture(event.pointerId);
    drag.current = { handle, id: item.sourceId, start: toCanvas(event), t0, rect0 };
    // Widget: as bordas mudam a moldura (mostra mais/menos da página), sem mudar o tamanho do conteúdo.
    if (page && handle.length === 1 && handle !== 'move') {
      drag.current.region0 = page.region;
      drag.current.pageId = page.id;
    }
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(event);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const { t0, rect0 } = d;
    const c = t0.crop;
    let next: Transform = t0;
    if (d.handle === 'content') {
      onPageRegion(d.pageId!, panRegion(d.region0 ?? null, t0.crop, rect0, dx, dy));
      return;
    }
    if (d.pageId && (d.handle === 'l' || d.handle === 'r' || d.handle === 't' || d.handle === 'b')) {
      const horizontal = d.handle === 'l' || d.handle === 'r';
      const next2 = extendRegion(d.region0 ?? null, t0.crop, rect0, d.handle, horizontal ? dx : dy);
      onPageRegion(d.pageId, next2.region);
      onTransform(d.id, { ...t0, x: next2.rect.x / canvas.w, y: next2.rect.y / canvas.h, w: next2.rect.w / canvas.w });
      return;
    }
    if (d.handle === 'move') {
      // Encaixe a ~8 px da tela (convertidos para pixels do programa).
      const threshold = (8 * canvas.w) / Math.max(1, box.w);
      const snapX = snapToCenterX(rect0.x + dx, rect0.w, canvas.w, threshold);
      const snapY = snapToCenterY(rect0.y + dy, rect0.h, canvas.h, (8 * canvas.h) / Math.max(1, box.h));
      if (snapX.snapped !== centerGuide.x || snapY.snapped !== centerGuide.y) setCenterGuide({ x: snapX.snapped, y: snapY.snapped });
      next = { ...t0, x: snapX.x / canvas.w, y: snapY.y / canvas.h };
    } else if (d.handle.length === 2) {
      // Canto: aumenta/diminui mantendo a proporção, preso ao canto oposto.
      const left = d.handle.includes('w');
      const top = d.handle.includes('n');
      const anchor = { x: left ? rect0.x + rect0.w : rect0.x, y: top ? rect0.y + rect0.h : rect0.y };
      const ratio = rect0.h / rect0.w;
      const w = Math.max(MIN_PX, Math.abs(p.x - anchor.x), Math.abs(p.y - anchor.y) / ratio);
      const h = w * ratio;
      next = { ...t0, x: (left ? anchor.x - w : anchor.x) / canvas.w, y: (top ? anchor.y - h : anchor.y) / canvas.h, w: w / canvas.w, ...(t0.h !== undefined ? { h: h / canvas.h } : {}) };
    } else {
      // Borda: corta aquele lado, sem mudar a escala da imagem.
      const perW = rect0.w / Math.max(0.02, 1 - c.l - c.r);
      const perH = rect0.h / Math.max(0.02, 1 - c.t - c.b);
      if (d.handle === 'l') {
        const l = clamp(c.l + dx / perW, 0, 0.95 - c.r);
        const shift = (l - c.l) * perW;
        next = { ...t0, x: t0.x + shift / canvas.w, w: t0.w - shift / canvas.w, crop: { ...c, l } };
      } else if (d.handle === 'r') {
        const r = clamp(c.r - dx / perW, 0, 0.95 - c.l);
        next = { ...t0, w: t0.w + ((c.r - r) * perW) / canvas.w, crop: { ...c, r } };
      } else if (d.handle === 't') {
        const t = clamp(c.t + dy / perH, 0, 0.95 - c.b);
        // Imagem esticada (altura própria): a altura acompanha o corte.
        next = { ...t0, y: t0.y + ((t - c.t) * perH) / canvas.h, crop: { ...c, t }, ...(t0.h !== undefined ? { h: ((1 - t - c.b) * perH) / canvas.h } : {}) };
      } else {
        const b = clamp(c.b - dy / perH, 0, 0.95 - c.t);
        next = { ...t0, crop: { ...c, b }, ...(t0.h !== undefined ? { h: ((1 - c.t - b) * perH) / canvas.h } : {}) };
      }
    }
    onTransform(d.id, next);
  };

  const end = () => {
    drag.current = null;
    setCenterGuide({ x: false, y: false });
  };

  /** Rodinha sobre um widget (no modo "mover conteúdo" ou com Option): aproxima/afasta a página na moldura. */
  const wheel = (event: ReactWheelEvent<HTMLElement>, item: SceneItem) => {
    const page = pageOf(sourceOf(item.sourceId));
    // Modo "mover conteúdo", Option+rodinha ou pinça do trackpad (chega como Ctrl+rodinha).
    if (!page || lockedIds.has(item.sourceId) || !(contentMode || event.altKey || event.ctrlKey)) return;
    event.stopPropagation();
    const b = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = clamp((event.clientX - b.left) / b.width, 0, 1);
    const fy = clamp((event.clientY - b.top) / b.height, 0, 1);
    // Sensível: um gesto curto de pinça ou um clique da rodinha já muda bem o tamanho.
    onPageRegion(page.id, zoomRegion(page.region, Math.exp(event.deltaY * 0.005), fx, fy));
  };

  const selected = videoItems.find((i) => i.sourceId === selectedId) ?? null;
  const selectedPage = selected ? pageOf(sourceOf(selected.sourceId)) : null;
  const selectedLocked = selected ? lockedIds.has(selected.sourceId) : false;
  const selectedFrame = selected ? compositor.sizes.get(selected.sourceId) : undefined;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  // Setas: movem a fonte selecionada 1 pixel da transmissão (Shift: 10). Lê sempre o estado mais novo.
  const me = useRef({}).current;
  const nudge = useRef<(e: KeyboardEvent) => void>(() => undefined);
  nudge.current = (e) => {
    const dir = ARROWS[e.key];
    if (!dir || viewOnly || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
    if (document.querySelector('[data-modal]')) return;
    if (arrowsOwner ? arrowsOwner !== me : editor) return;
    if (!selected || lockedIds.has(selected.sourceId)) return;
    const rect = rectOf(selected);
    if (!rect) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const t0 = selected.transform ?? toTransform(rect, canvas);
    onTransform(selected.sourceId, { ...t0, x: t0.x + (dir[0] * step) / canvas.w, y: t0.y + (dir[1] * step) / canvas.h });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => nudge.current(e);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (arrowsOwner === me) arrowsOwner = null;
    };
  }, [me]);

  return (
    <div className="program" onPointerDownCapture={() => { if (!viewOnly) arrowsOwner = me; }}>
      {!viewOnly && <div className="program-tools">
        {selected ? (
          <>
            <span className="program-selected" title={sourceOf(selected.sourceId).device.label}>{displayName(sourceOf(selected.sourceId).name)}</span>
            {selectedLocked && <span className="hint program-locked"><LockKeyhole size={13} /> Travado: abra o cadeado na área Cenas para mexer</span>}
            {selectedPage && !selectedLocked && (
              <button type="button" className={`btn btn-small ${contentMode ? 'btn-on' : ''}`} aria-pressed={contentMode} onClick={() => setContentMode(!contentMode)} data-tip="Arraste dentro do widget para mover a página; rodinha para aproximar ou afastar">
                <Hand size={13} /> {contentMode ? 'Movendo conteúdo' : 'Mover conteúdo'}
              </button>
            )}
            {selectedPage && !selectedLocked && (() => {
              const zoom = contentZoom(selectedPage.region);
              const min = Math.ceil(zoom.min);
              const set = (percent: number) => onPageRegion(selectedPage.id, setContentZoom(selectedPage.region, clamp(percent, zoom.min, 1000)));
              return (
                <span className="content-zoom" title="Tamanho do conteúdo dentro do widget (a moldura não muda)">
                  <span className="content-zoom-label">Conteúdo</span>
                  <button type="button" className="btn btn-small btn-icon" aria-label="Diminuir o conteúdo" data-tip="Diminuir o conteúdo" disabled={zoom.value <= zoom.min + 0.5} onClick={() => set(zoom.value / 1.3)}><ZoomOut size={13} /></button>
                  <input type="range" min={min} max={1000} step={1} value={Math.round(zoom.value)} aria-label="Tamanho do conteúdo" onChange={(e) => set(Number(e.target.value))} />
                  <button type="button" className="btn btn-small btn-icon" aria-label="Aumentar o conteúdo" data-tip="Aumentar o conteúdo" disabled={zoom.value >= 999} onClick={() => set(zoom.value * 1.3)}><ZoomIn size={13} /></button>
                  <output className="content-zoom-value">{Math.round(zoom.value)}%</output>
                </span>
              );
            })()}
            <button type="button" className="btn btn-small" disabled={selectedLocked} onClick={() => onTransform(selected.sourceId, null)} data-tip="Imagem inteira, centralizada"><Minimize size={13} /> Encaixar</button>
            <button type="button" className="btn btn-small" disabled={!selectedFrame || selectedLocked} onClick={() => selectedFrame && onTransform(selected.sourceId, fillTransform(selectedFrame, sourceOf(selected.sourceId).video, canvas, pageOf(sourceOf(selected.sourceId))?.region ?? null))} data-tip="Tela inteira, cortando o que sobra"><Maximize size={13} /> Preencher</button>
            <button type="button" className="btn btn-small" data-tip="Volta a mostrar a imagem sem corte" disabled={!selected.transform || selectedLocked} onClick={() => selected.transform && onTransform(selected.sourceId, { ...selected.transform, crop: { ...NO_CROP } })}><Crop size={13} /> Tirar corte</button>
            {onBorder && <BorderMenu border={selected.border ?? null} disabled={selectedLocked} onChange={(b) => onBorder(selected.sourceId, b)} />}
            {editor && onRemove && <button type="button" className="btn btn-small" data-tip="Tira este elemento da prévia (não mexe no Programa)" onClick={() => onRemove(selected.sourceId)}><EyeOff size={13} /> Tirar da prévia</button>}
            {!editor && <button type="button" className="btn btn-small" data-tip={selected.hidden ? 'Mostrar esta fonte no programa' : 'Esconder esta fonte do programa'} onClick={() => onToggleHidden(selected.sourceId)}>{selected.hidden ? <Eye size={13} /> : <EyeOff size={13} />} {selected.hidden ? 'Mostrar' : 'Ocultar'}</button>}
          </>
        ) : (
          <span className="hint">Clique numa fonte para mover (setas: 1 px; Shift+setas: 10 px). Cantos: tamanho. Bordas: cortar.</span>
        )}
        {!editor && <span className="program-hud">
          {hud.quality && <QualityChip live={live} output={output} extras={extras} />}
          {hud.viewers && (
            <span className="hud-chip" data-tip={!live ? 'Aparece durante a transmissão' : extras?.error ?? 'Pessoas assistindo agora no YouTube (atualiza a cada 20 s)'}>
              <Users size={13} /> {live && extras?.viewers != null ? `${extras.viewers.toLocaleString('pt-BR')} online` : '— online'}
            </span>
          )}
          {hud.viewers && (
            <span className="hud-chip" data-tip={!live ? 'Aparece durante a transmissão' : extras?.error ?? 'Curtidas da live no YouTube (atualiza a cada 20 s)'}>
              <ThumbsUp size={13} /> {live && extras?.likes != null ? `${extras.likes.toLocaleString('pt-BR')} curtida${extras.likes === 1 ? '' : 's'}` : '— curtidas'}
            </span>
          )}
          <span className="hud-toggles" role="group" aria-label="Indicadores do programa">
            {([
              ['quality', Wifi, 'Qualidade da conexão'],
              ['viewers', Users, 'Pessoas online e curtidas'],
              ['chat', MessageSquare, 'Comentários ao vivo'],
            ] as const).map(([key, Icon, name]) => (
              <button
                key={key}
                type="button"
                className={`icon-btn hud-toggle ${hud[key] ? 'icon-btn-on' : ''}`}
                aria-pressed={hud[key]}
                aria-label={`${name}: ${hud[key] ? 'ligado' : 'desligado'}`}
                data-tip={`${name} · ${hud[key] ? 'clique para esconder' : 'clique para mostrar'}`}
                onClick={() => onHud({ ...hud, [key]: !hud[key] })}
              >
                <Icon size={15} />
              </button>
            ))}
          </span>
        </span>}
      </div>}
      <div className="program-body">
      <div className="program-host" ref={host}>
        <div
          ref={overlay}
          className={`program-overlay ${viewOnly ? 'program-overlay-off' : ''}`}
          style={{ width: box.w, height: box.h }}
          onPointerDown={() => onSelect(null)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          data-testid="program-overlay"
        >
          {centerGuide.x && <div className="center-guide" aria-hidden="true" />}
          {centerGuide.y && <div className="center-guide center-guide-y" aria-hidden="true" />}
          {!viewOnly && videoItems.map((item) => {
            const rect = rectOf(item);
            const status = videos.current.get(item.sourceId)?.status;
            const lost = status === 'desconectado' || status === 'falhou';
            if (!rect) {
              return lost ? <div key={item.sourceId} className="layer-lost">{displayName(sourceOf(item.sourceId).name)}: sem sinal</div> : null;
            }
            const isSelected = item.sourceId === selectedId;
            const locked = lockedIds.has(item.sourceId);
            return (
              <div
                key={item.sourceId}
                className={`layer-box ${isSelected ? 'layer-box-selected' : ''} ${item.hidden ? 'layer-box-hidden' : ''} ${lost ? 'layer-box-lost' : ''} ${contentMode && pageOf(sourceOf(item.sourceId)) && !locked ? 'layer-box-content' : ''} ${locked ? 'layer-box-locked' : ''}`}
                style={{ left: pct(rect.x, canvas.w), top: pct(rect.y, canvas.h), width: pct(rect.w, canvas.w), height: pct(rect.h, canvas.h) }}
                onPointerDown={(e) => begin(e, item, 'move')}
                onWheel={(e) => wheel(e, item)}
              >
                {(isSelected || lost) && <span className="layer-name">{locked && <LockKeyhole size={11} />} {displayName(sourceOf(item.sourceId).name)}{lost ? ' · sem sinal' : ''}</span>}
                {isSelected && !locked && (['nw', 'ne', 'sw', 'se', 'l', 'r', 't', 'b'] as Handle[]).map((h) => (
                  <i key={h} className={`handle handle-${h}`} onPointerDown={(e) => begin(e, item, h)}  />
                ))}
                {isSelected && !locked && !lost && (
                  <div className="layer-tools" onPointerDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="layer-fill layer-center"
                      aria-label="Centralizar"
                      onClick={(e) => { e.stopPropagation(); onTransform(item.sourceId, centerTransform(rect, canvas, item.transform)); }}
                      data-tip="Centralizar"
                    >
                      <LocateFixed size={14} />
                    </button>
                    <button
                      type="button"
                      className={`layer-fill ${item.fill ? 'layer-fill-on' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onToggleFill(item.sourceId); }}
                      data-tip={item.fill ? 'Volta para o tamanho e o lugar de antes' : 'Ocupa a tela toda, sem deformar'}
                    >
                      {item.fill ? <><Shrink size={13} /> Voltar</> : <><Expand size={13} /> Tela cheia</>}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!editor && hud.chat && <LiveChat extras={live ? extras : null} />}
      </div>
      {videoItems.map((item) => <LayerTrack key={item.sourceId} source={sourceOf(item.sourceId)} register={register} />)}
    </div>
  );
}
