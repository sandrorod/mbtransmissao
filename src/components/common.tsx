import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { levelFraction } from '../audio/engine';
import type { PooledStream } from '../devices/pool';
import type { VideoSettings } from '../types/studio';

export function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" data-modal>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Barra de nível atualizada a cada quadro, sem redesenhar o React. Verde → amarelo → vermelho perto do clipe. */
export function LevelBar({ read, vertical = false }: { read: () => number; vertical?: boolean }) {
  const fill = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    let peakHold = 0;
    let heldAt = 0;
    let frame = requestAnimationFrame(function tick(now) {
      const db = latest.current();
      const level = levelFraction(db);
      if (level >= peakHold || now - heldAt > 1200) {
        peakHold = level;
        heldAt = now;
      }
      const size = `${level * 100}%`;
      if (fill.current) {
        if (vertical) fill.current.style.height = size;
        else fill.current.style.width = size;
        fill.current.dataset.zone = db > -3 ? 'clip' : db > -12 ? 'hot' : 'ok';
      }
      if (hold.current) {
        if (vertical) hold.current.style.bottom = `${peakHold * 100}%`;
        else hold.current.style.left = `${peakHold * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [vertical]);
  return (
    <div className={`level ${vertical ? 'level-vertical' : ''}`} aria-hidden="true">
      <div ref={fill} className="level-fill" />
      <div ref={hold} className="level-hold" />
    </div>
  );
}

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

const ASPECT_VALUE: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 };

const STATUS_TEXT: Record<string, string> = {
  abrindo: 'Abrindo dispositivo…',
  desconectado: 'Sem sinal: dispositivo desconectado',
  falhou: 'Não foi possível abrir',
  parado: '',
};

/**
 * Imagem real do dispositivo, com proporção (corte), rotação e espelho aplicados.
 * Também aplica na câmera os parâmetros de captura que ela suporta (zoom, brilho…).
 */
export function VideoView({ pooled, settings, label, compact = false }: { pooled: PooledStream; settings?: VideoSettings; label?: string; compact?: boolean }) {
  const [box, size] = useSize<HTMLDivElement>();
  const video = useRef<HTMLVideoElement>(null);
  const [natural, setNatural] = useState(16 / 9);
  const { stream, status, error } = pooled;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  const extra = JSON.stringify(settings?.extra ?? {});
  useEffect(() => {
    const track = stream?.getVideoTracks()[0];
    const values = JSON.parse(extra) as Record<string, number>;
    if (!track || Object.keys(values).length === 0) return;
    void track.applyConstraints({ advanced: [values as MediaTrackConstraintSet] }).catch(() => undefined);
  }, [stream, extra]);

  const rotation = settings?.rotation ?? 0;
  const sideways = rotation === 90 || rotation === 270;
  const sourceAspect = sideways ? 1 / natural : natural;
  const aspect = settings && settings.aspect !== 'original' ? ASPECT_VALUE[settings.aspect] : sourceAspect;
  // Maior retângulo com a proporção pedida que cabe na área.
  let width = size.width;
  let height = width / aspect;
  if (height > size.height) {
    height = size.height;
    width = height * aspect;
  }
  // O vídeo cobre o retângulo (cortando o que sobra); de lado, largura e altura trocam.
  const coverW = Math.max(width, height * sourceAspect);
  const coverH = coverW / sourceAspect;
  const videoW = sideways ? coverH : coverW;
  const videoH = sideways ? coverW : coverH;
  const transform = `translate(-50%, -50%) rotate(${rotation}deg) scaleX(${settings?.mirror ? -1 : 1})`;

  return (
    <div ref={box} className={`video-view ${compact ? 'video-view-compact' : ''}`}>
      <div className="video-frame" style={{ width, height }}>
        <video
          ref={video}
          muted
          playsInline
          autoPlay
          onLoadedMetadata={(e) => setNatural(e.currentTarget.videoWidth / e.currentTarget.videoHeight || 16 / 9)}
          // O celular girou (em pé ↔ deitado): o tamanho do vídeo muda sem carregar de novo.
          onResize={(e) => setNatural(e.currentTarget.videoWidth / e.currentTarget.videoHeight || 16 / 9)}
          style={{ width: videoW, height: videoH, transform, visibility: stream ? 'visible' : 'hidden' }}
        />
      </div>
      {status !== 'ativo' && status !== 'parado' && (
        <div className={`video-status video-status-${status}`}>
          <strong>{STATUS_TEXT[status]}</strong>
          {label && <span>{label}</span>}
          {error && status !== 'abrindo' && <small>{error}</small>}
        </div>
      )}
    </div>
  );
}

export function StatusTag({ status }: { status: 'conectado' | 'ativo' | 'abrindo' | 'desconectado' | 'falhou' | 'parado' }) {
  const text = { conectado: 'Conectado', ativo: 'Em uso', abrindo: 'Abrindo', desconectado: 'Desconectado', falhou: 'Falhou', parado: 'Conectado' }[status];
  return <span className={`status-tag status-${status}`}><i />{text}</span>;
}

/**
 * Dica ao passar o mouse: qualquer elemento com data-tip mostra o nome/explicação logo abaixo dele
 * (acima, se não couber). Fica fora dos painéis, então nunca é cortada pela borda de uma área.
 */
export function installTooltips(): () => void {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    target = null;
    tip.classList.remove('tooltip-on');
  };
  const show = () => {
    if (!target || !target.isConnected) return hide();
    tip.textContent = target.dataset.tip ?? '';
    tip.classList.add('tooltip-on');
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const below = r.bottom + 6 + t.height <= window.innerHeight;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - t.height - 6}px`;
  };
  const over = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el === target) return;
    hide();
    if (!el || !el.dataset.tip) return;
    target = el;
    timer = setTimeout(show, 250);
  };
  document.addEventListener('pointerover', over);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('scroll', hide, true);
  return () => {
    document.removeEventListener('pointerover', over);
    document.removeEventListener('pointerdown', hide, true);
    window.removeEventListener('blur', hide);
    document.removeEventListener('scroll', hide, true);
    tip.remove();
  };
}
