import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Pause, Play, Scissors } from 'lucide-react';
import type { ChromaKey } from '../types/studio';
import { ChromaKeyer } from '../program/chroma';

/** Trecho escolhido da vinheta, em segundos do vídeo. */
export interface Cut {
  start: number;
  end: number;
}

/** Menor trecho que dá para deixar (abaixo disso a vinheta nem aparece no ar). */
export const MIN_CUT = 0.3;

const tenth = (n: number) => Math.round(n * 10) / 10;
export const timeLabel = (s: number) => {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0').replace('.', ',')}`;
};

/**
 * Prévia da vinheta (uma imagem só: com o fundo removido mostra o resultado por cima do quadriculado) e a
 * linha do tempo para cortar, como nos editores de vídeo: miniaturas, alças de começo e fim e cursor.
 */
export function VignetteEditor({ url, cut, onCut, onLength, chroma, onChroma, picking, setPicking }: {
  url: string;
  /** null = ainda sem duração (o vídeo está abrindo). */
  cut: Cut | null;
  onCut: (cut: Cut) => void;
  onLength: (seconds: number) => void;
  chroma: ChromaKey;
  onChroma: (c: ChromaKey) => void;
  picking: boolean;
  setPicking: (on: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const result = useRef<HTMLCanvasElement>(null);
  const keyer = useRef<ChromaKeyer | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const cutRef = useRef(cut);
  cutRef.current = cut;
  const keyed = chroma.enabled && !picking;

  // Acompanha o vídeo (cursor da linha do tempo) e repete só o trecho escolhido.
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const v = video.current;
      if (v) {
        const c = cutRef.current;
        if (c && !v.paused && (v.currentTime >= c.end || v.currentTime < c.start - 0.05)) v.currentTime = c.start;
        setTime(v.currentTime);
        const canvas = result.current;
        if (keyed && canvas && v.readyState >= 2 && v.videoWidth > 0) {
          keyer.current ??= new ChromaKeyer();
          if (canvas.width !== v.videoWidth) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; }
          const g = canvas.getContext('2d');
          g?.clearRect(0, 0, canvas.width, canvas.height);
          g?.drawImage(keyer.current.process(v, chroma) ?? v, 0, 0);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [keyed, chroma]);

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, duration || t));
    setTime(v.currentTime);
  };

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      const c = cutRef.current;
      if (c && (v.currentTime >= c.end - 0.05 || v.currentTime < c.start)) v.currentTime = c.start;
      void v.play().catch(() => undefined);
    } else v.pause();
  };

  /** Cor do ponto clicado no quadro atual do vídeo (conta-gotas). */
  const pick = (e: ReactMouseEvent<HTMLElement>) => {
    const v = video.current;
    if (!picking || !v?.videoWidth) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const x = Math.floor((e.clientX - r.left - (r.width - v.videoWidth * scale) / 2) / scale);
    const y = Math.floor((e.clientY - r.top - (r.height - v.videoHeight * scale) / 2) / scale);
    if (x < 0 || y < 0 || x >= v.videoWidth || y >= v.videoHeight) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(v, 0, 0);
    const [red, green, blue] = g.getImageData(x, y, 1, 1).data;
    onChroma({ ...chroma, enabled: true, color: `#${[red, green, blue].map((n) => n.toString(16).padStart(2, '0')).join('')}` });
    setPicking(false);
  };

  return (
    <div className="vignette-editor">
      <div className={`vignette-stage ${keyed ? 'vignette-stage-keyed' : ''} ${picking ? 'intro-picking' : ''}`} onClick={picking ? pick : toggle}>
        <video
          ref={video}
          src={url}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d)) {
              setDuration(d);
              onLength(d);
            }
            if (cutRef.current) e.currentTarget.currentTime = cutRef.current.start;
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        {keyed && <canvas ref={result} aria-label="Resultado com o fundo removido" />}
        {!playing && !picking && <span className="vignette-play-hint" aria-hidden="true"><Play size={22} /></span>}
      </div>
      {picking && <p className="hint">Clique no vídeo, na cor do fundo que vai sumir.</p>}
      {keyed && <p className="hint">O quadriculado é onde vai aparecer a imagem do Programa.</p>}
      {cut && duration > 0 && (
        <Timeline url={url} duration={duration} cut={cut} time={time} onCut={onCut} onSeek={seek} playing={playing} onToggle={toggle} />
      )}
    </div>
  );
}

/** Miniaturas do vídeo para a faixa da linha do tempo (geradas uma vez por arquivo). */
function useThumbnails(url: string, duration: number, count: number): string[] {
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    if (!duration) return;
    let cancelled = false;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 72;
    const g = canvas.getContext('2d');
    const out: string[] = [];
    const next = (i: number) => {
      if (cancelled || i >= count || !g) return;
      v.onseeked = () => {
        if (cancelled) return;
        const scale = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
        const w = v.videoWidth * scale;
        const h = v.videoHeight * scale;
        g.fillStyle = '#000';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(v, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        out.push(canvas.toDataURL('image/jpeg', 0.6));
        setThumbs([...out]);
        next(i + 1);
      };
      v.currentTime = Math.min(duration - 0.05, ((i + 0.5) * duration) / count);
    };
    v.onloadeddata = () => next(0);
    return () => {
      cancelled = true;
      v.removeAttribute('src');
      v.load();
    };
  }, [url, duration, count]);
  return thumbs;
}

type Drag = 'start' | 'end' | 'head';

function Timeline({ url, duration, cut, time, onCut, onSeek, playing, onToggle }: {
  url: string;
  duration: number;
  cut: Cut;
  time: number;
  onCut: (cut: Cut) => void;
  onSeek: (t: number) => void;
  playing: boolean;
  onToggle: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const thumbs = useThumbnails(url, duration, 12);
  const pct = (t: number) => `${(Math.max(0, Math.min(t, duration)) / duration) * 100}%`;

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const apply = (kind: Drag, t: number) => {
    if (kind === 'start') {
      const start = tenth(Math.min(t, cut.end - MIN_CUT));
      onCut({ start: Math.max(0, start), end: cut.end });
      onSeek(Math.max(0, start));
    } else if (kind === 'end') {
      const end = tenth(Math.max(t, cut.start + MIN_CUT));
      onCut({ start: cut.start, end: Math.min(duration, end) });
      onSeek(Math.max(cut.start, Math.min(duration, end) - 0.05));
    } else onSeek(t);
  };

  const down = (kind: Drag) => (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = kind;
    setDragging(kind);
    track.current?.setPointerCapture(e.pointerId);
    apply(kind, timeAt(e.clientX));
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) apply(drag.current, timeAt(e.clientX));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(null);
    if (track.current?.hasPointerCapture(e.pointerId)) track.current.releasePointerCapture(e.pointerId);
  };

  // Cortar no cursor, como o botão de dividir dos editores: começo ou fim vai para onde o cursor está.
  const cutStartHere = () => onCut({ start: tenth(Math.min(time, cut.end - MIN_CUT)), end: cut.end });
  const cutEndHere = () => onCut({ start: cut.start, end: tenth(Math.max(time, cut.start + MIN_CUT)) });
  const length = cut.end - cut.start;

  return (
    <div className="trim">
      <div className="trim-toolbar">
        <button type="button" className="icon-btn" aria-label={playing ? 'Pausar' : 'Tocar o trecho'} data-tip={playing ? 'Pausar' : 'Tocar o trecho'} onClick={onToggle}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <span className="trim-clock">{timeLabel(time)}</span>
        <span className="trim-spacer" />
        <button type="button" className="btn btn-small" onClick={cutStartHere} disabled={time >= cut.end - MIN_CUT}><Scissors size={13} /> Começar aqui</button>
        <button type="button" className="btn btn-small" onClick={cutEndHere} disabled={time <= cut.start + MIN_CUT}><Scissors size={13} /> Terminar aqui</button>
      </div>
      <div
        ref={track}
        className={`trim-track ${dragging ? 'trim-dragging' : ''}`}
        onPointerDown={down('head')}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        role="group"
        aria-label="Linha do tempo da vinheta"
      >
        <div className="trim-strip">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className="trim-thumb" style={thumbs[i] ? { backgroundImage: `url(${thumbs[i]})` } : undefined} />
          ))}
        </div>
        <div className="trim-shade" style={{ left: 0, width: pct(cut.start) }} />
        <div className="trim-shade" style={{ left: pct(cut.end), right: 0 }} />
        <div className="trim-window" style={{ left: pct(cut.start), width: `calc(${pct(cut.end)} - ${pct(cut.start)})` }}>
          <span className="trim-handle trim-handle-start" onPointerDown={down('start')} role="slider" aria-label="Começo da vinheta" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={cut.start} />
          <span className="trim-handle trim-handle-end" onPointerDown={down('end')} role="slider" aria-label="Fim da vinheta" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={cut.end} />
        </div>
        <div className="trim-head" style={{ left: pct(time) }} />
      </div>
      <div className="trim-labels">
        <span>Começa em <strong>{timeLabel(cut.start)}</strong></span>
        <span className="trim-length">No ar: <strong>{length.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s</strong> de {duration.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s</span>
        <span>Termina em <strong>{timeLabel(cut.end)}</strong></span>
      </div>
      <p className="hint">Arraste as alças amarelas para cortar o começo e o fim. Clique ou arraste na faixa para ver um ponto; "Começar aqui" e "Terminar aqui" cortam onde está o cursor.</p>
    </div>
  );
}
