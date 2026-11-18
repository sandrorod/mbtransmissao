import { useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { X, Maximize2 } from 'lucide-react';
import type { Layout, PanelColumn, PanelId, ZoneId, ZoneSpans } from '../types/studio';

/** Menor fração que uma área pode ter na sua faixa. */
export const MIN_FRACTION = 0.08;
const SPLITTER = 8;
export const DRAG_TYPE = 'application/x-estudio-area';

/**
 * Nova divisão quando o operador arrasta a divisória depois da área `index`: essa área fica com o tamanho
 * que a divisória marcar e TODAS as outras ficam iguais entre si, dividindo o que sobrou.
 * `pos` é a posição da divisória (0 a 1) na faixa.
 */
export function resizeEqualized(count: number, index: number, pos: number, min = MIN_FRACTION): number[] {
  if (count < 2) return [1];
  const rest = count - 1;
  // A divisória fica em: index·(1−s)/rest + s. Resolve s para ela cair embaixo do ponteiro.
  let s = index >= rest ? pos : (pos * rest - index) / (rest - index);
  s = Math.min(Math.max(s, min), 1 - min * rest);
  const other = (1 - s) / rest;
  return Array.from({ length: count }, (_, i) => (i === index ? s : other));
}

type Spans = Record<ZoneId, ZoneSpans>;
type Zones = Record<ZoneId, PanelColumn[]> & { spans?: Spans };
const NO_SPANS = (): Spans => ({ left: { top: [], bottom: [] }, bottom: { top: [], bottom: [] } });

/**
 * Onde soltar uma área: numa coluna nova (lado a lado), empilhada acima/abaixo de outra área, ou na largura
 * toda da faixa (acima ou abaixo das colunas; `at` = posição entre as áreas que já estão ali).
 */
export type PanelTarget =
  | { kind: 'column'; zone: ZoneId; index: number }
  | { kind: 'stack'; anchor: PanelId; below: boolean }
  | { kind: 'span'; zone: ZoneId; side: 'top' | 'bottom'; at?: number };

const cloneSpans = (s?: Spans): Spans => {
  const base = s ?? NO_SPANS();
  return { left: { top: [...base.left.top], bottom: [...base.left.bottom] }, bottom: { top: [...base.bottom.top], bottom: [...base.bottom.bottom] } };
};
const cloneZones = (z: Zones): Zones & { spans: Spans } => ({ left: z.left.map((c) => [...c]), bottom: z.bottom.map((c) => [...c]), spans: cloneSpans(z.spans) });

/** Onde está a área: faixa, coluna e posição na pilha. */
export function locate(zones: Zones, panel: PanelId): { zone: ZoneId; col: number; row: number } | null {
  for (const zone of ['left', 'bottom'] as const) {
    const col = zones[zone].findIndex((c) => c.includes(panel));
    if (col >= 0) return { zone, col, row: zones[zone][col].indexOf(panel) };
  }
  return null;
}

/** Área na largura toda: faixa, lado (acima/abaixo das colunas) e posição. */
export function locateSpan(spans: Spans | undefined, panel: PanelId): { zone: ZoneId; side: 'top' | 'bottom'; index: number } | null {
  for (const zone of ['left', 'bottom'] as const) {
    for (const side of ['top', 'bottom'] as const) {
      const index = spans?.[zone][side].indexOf(panel) ?? -1;
      if (index >= 0) return { zone, side, index };
    }
  }
  return null;
}

/** Todas as áreas abertas (nas colunas ou na largura toda). */
export const openPanels = (layout: Zones): PanelId[] => [...layout.left.flat(), ...layout.bottom.flat(), ...(['left', 'bottom'] as const).flatMap((z) => [...(layout.spans?.[z].top ?? []), ...(layout.spans?.[z].bottom ?? [])])];

/**
 * Leva uma área para outro lugar: ao lado (coluna nova) ou embaixo/em cima de outra (mesma coluna).
 * Uma faixa que fica vazia some da tela. "Dispositivos" fica sempre sozinho no topo da esquerda.
 */
export function movePanel(zones: Zones, panel: PanelId, target: PanelTarget): (Zones & { spans: Spans }) | null {
  const from = locate(zones, panel);
  const fromSpan = from ? null : locateSpan(zones.spans, panel);
  if ((!from && !fromSpan) || panel === 'dispositivos') return null;
  if (target.kind === 'stack' && (target.anchor === panel || target.anchor === 'dispositivos')) return null;
  const next = cloneZones(zones);
  let alone = false;
  if (from) {
    const column = next[from.zone][from.col];
    column.splice(from.row, 1);
    alone = column.length === 0;
    if (alone) next[from.zone].splice(from.col, 1);
  } else if (fromSpan) {
    next.spans[fromSpan.zone][fromSpan.side].splice(fromSpan.index, 1);
  }
  if (target.kind === 'span') {
    const list = next.spans[target.zone][target.side];
    // Acima das colunas: a nova fica logo em cima delas; abaixo: logo embaixo delas.
    let at = target.at ?? (target.side === 'top' ? list.length : 0);
    if (fromSpan && fromSpan.zone === target.zone && fromSpan.side === target.side && fromSpan.index < at) at -= 1;
    list.splice(Math.min(Math.max(at, 0), list.length), 0, panel);
  } else if (target.kind === 'stack') {
    const at = locate(next, target.anchor);
    if (!at) {
      // Soltou em cima/embaixo de uma área da largura toda: vira outra linha da largura toda.
      const span = locateSpan(next.spans, target.anchor);
      if (!span) return null;
      next.spans[span.zone][span.side].splice(span.index + (target.below ? 1 : 0), 0, panel);
    } else next[at.zone][at.col].splice(at.row + (target.below ? 1 : 0), 0, panel);
  } else {
    let index = target.index;
    if (alone && from && from.zone === target.zone && from.col < index) index -= 1;
    if (target.zone === 'left' && next.left[0]?.[0] === 'dispositivos') index = Math.max(index, 1);
    next[target.zone].splice(Math.min(Math.max(index, 0), next[target.zone].length), 0, [panel]);
  }
  return JSON.stringify(next) === JSON.stringify(cloneZones(zones)) ? null : next;
}

/** Tira a fração de uma área da faixa e redistribui o resto (as outras mantêm a proporção entre si). */
function dropSize(sizes: number[] | null, index: number): number[] | null {
  if (!sizes || index < 0 || index >= sizes.length || sizes.length < 2) return null;
  const rest = sizes.filter((_, i) => i !== index);
  const total = rest.reduce((a, b) => a + b, 0);
  return total > 0 ? rest.map((x) => x / total) : null;
}

const sizedColumns = (layout: Layout, zone: ZoneId) => (zone === 'left' ? layout.left.filter((c) => c[0] !== 'dispositivos') : layout.bottom);

/** Fecha uma área (X): ela sai da faixa e fica guardada com o lugar onde estava, para reabrir ali. */
export function closePanel(layout: Layout, panel: PanelId): Layout {
  const at = locate(layout, panel);
  if (!at) {
    const span = locateSpan(layout.spans, panel);
    if (!span) return layout;
    const spans = cloneSpans(layout.spans);
    spans[span.zone][span.side].splice(span.index, 1);
    const { [span.zone]: _dropped, ...spanSizes } = layout.spanSizes ?? {};
    return { ...layout, spans, spanSizes, closed: [...layout.closed.filter((c) => c.id !== panel), { id: panel, zone: span.zone, index: span.index, row: null, span: span.side }] };
  }
  const column = layout[at.zone][at.col];
  const alone = column.length === 1;
  const columns = alone ? layout[at.zone].filter((_, i) => i !== at.col) : layout[at.zone].map((c, i) => (i === at.col ? c.filter((id) => id !== panel) : c));
  const next: Layout = { ...layout, [at.zone]: columns, closed: [...layout.closed.filter((c) => c.id !== panel), { id: panel, zone: at.zone, index: at.col, row: alone ? null : at.row }] };
  if (alone && panel !== 'dispositivos') {
    const index = sizedColumns(layout, at.zone).indexOf(column);
    if (at.zone === 'bottom') next.bottomSizes = dropSize(layout.bottomSizes, index);
    else next.leftSizes = dropSize(layout.leftSizes, index);
  }
  return next;
}

/** Reabre uma área fechada no lugar onde estava (na mesma pilha, se ela ainda existir; senão numa coluna). */
export function openPanel(layout: Layout, panel: PanelId): Layout {
  if (locate(layout, panel) || locateSpan(layout.spans, panel)) return layout;
  const saved = layout.closed.find((c) => c.id === panel) ?? { id: panel, zone: panel === 'dispositivos' ? 'left' as const : 'bottom' as const, index: 99, row: null };
  const columns = layout[saved.zone].map((c) => [...c]);
  const closed = layout.closed.filter((c) => c.id !== panel);
  if (saved.span && panel !== 'dispositivos') {
    const spans = cloneSpans(layout.spans);
    const list = spans[saved.zone][saved.span];
    list.splice(Math.min(saved.index, list.length), 0, panel);
    const { [saved.zone]: _dropped, ...spanSizes } = layout.spanSizes ?? {};
    return { ...layout, spans, spanSizes, closed };
  }
  if (panel === 'dispositivos') return { ...layout, left: [['dispositivos'], ...columns.filter((c) => !c.includes('dispositivos'))], closed };
  const stack = saved.row !== null ? columns[saved.index] : undefined;
  if (stack && stack[0] !== 'dispositivos') {
    stack.splice(Math.min(saved.row!, stack.length), 0, panel);
    return { ...layout, [saved.zone]: columns, closed };
  }
  const min = saved.zone === 'left' && columns[0]?.[0] === 'dispositivos' ? 1 : 0;
  columns.splice(Math.min(Math.max(saved.index, min), columns.length), 0, [panel]);
  return { ...layout, [saved.zone]: columns, closed, ...(saved.zone === 'bottom' ? { bottomSizes: null } : { leftSizes: null }) };
}

/** Ao lado do X: abre a área numa janela grande (popup); fechar a janela devolve a área ao lugar. */
export function AreaExpand({ name, onExpand, className = '' }: { name: string; onExpand: () => void; className?: string }) {
  return (
    <button type="button" className={`icon-btn area-expand ${className}`} aria-label={`Expandir a área ${name}`} data-tip={`Abrir ${name} em janela grande`} onClick={onExpand}>
      <Maximize2 size={13} />
    </button>
  );
}

/** X no canto de cima de cada área: fecha a área (ela volta pelo menu Exibição). */
export function AreaClose({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <button type="button" className="icon-btn area-close" aria-label={`Fechar a área ${name}`} data-tip={`Fechar ${name} (reabra em Menu › Exibição)`} onClick={onClose}>
      <X size={14} />
    </button>
  );
}

function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
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

/** Arrasta uma divisória com o mouse e informa a posição do ponteiro (em px, relativa ao elemento de referência). */
function startDrag(e: ReactPointerEvent, onMove: (clientX: number, clientY: number) => void, onEnd?: () => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev: PointerEvent) => onMove(ev.clientX, ev.clientY);
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    document.body.classList.remove('resizing');
    onEnd?.();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

/** Divisória entre duas regiões fixas (coluna da esquerda × centro, programa × linha de baixo). */
export function Splitter({ dir, onDrag }: { dir: 'col' | 'row'; onDrag: (clientX: number, clientY: number) => void }) {
  return (
    <div
      className={`splitter splitter-${dir}`}
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => startDrag(e, onDrag)}
    />
  );
}

interface ZoneProps {
  zone: ZoneId;
  /** Colunas lado a lado; cada uma com uma ou mais áreas empilhadas. */
  columns: PanelColumn[];
  sizes: number[] | null;
  /** Divisão automática (quando o operador ainda não mexeu), a partir do tamanho real da faixa. */
  defaults: (width: number, height: number) => number[];
  render: (panel: PanelId) => ReactNode;
  onResize: (sizes: number[]) => void;
  /** Alturas das áreas empilhadas (chave: ids da coluna unidos por "+"). */
  stackSizes: Record<string, number[]>;
  onStackResize: (key: string, sizes: number[]) => void;
  /** Soltaram uma área: `index` das colunas é relativo a esta faixa. */
  onMove: (panel: PanelId, target: PanelTarget) => void;
  /** Áreas na largura toda da faixa (acima e abaixo das colunas). */
  spans: ZoneSpans;
  /** Altura de cada linha: [acima…, colunas, abaixo…]; null = partes iguais. */
  spanSizes: number[] | null;
  onSpanResize: (sizes: number[]) => void;
}

type DropSide = 'left' | 'right' | 'top' | 'bottom';

/** Lado onde a área vai cair: nas bordas laterais = ao lado (coluna nova); no meio = em cima/embaixo (empilhada). */
export function dropSide(rx: number, ry: number): DropSide {
  if (rx < 0.25) return 'left';
  if (rx > 0.75) return 'right';
  return ry < 0.5 ? 'top' : 'bottom';
}

/** Faixa fina no alto e embaixo da área toda: soltar ali põe a área na largura toda. */
const SPAN_EDGE = 24;

/**
 * Faixa de áreas redimensionáveis e reordenáveis (arrastando o título de uma área): lado a lado, empilhadas, ou
 * na largura toda (soltando na borda de cima ou de baixo da faixa).
 */
export function Zone(props: ZoneProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const rowRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ panel: PanelId; side: DropSide } | null>(null);
  const [spanDrop, setSpanDrop] = useState<'top' | 'bottom' | null>(null);
  const n = props.columns.length;
  const fractions = props.sizes && props.sizes.length === n ? props.sizes : size.width ? props.defaults(size.width, size.height) : Array(n).fill(1 / n);
  // Linhas da faixa: áreas da largura toda em cima, as colunas, e as de baixo.
  const lines: ({ kind: 'span'; panel: PanelId; side: 'top' | 'bottom'; index: number } | { kind: 'columns' })[] = [
    ...props.spans.top.map((panel, index) => ({ kind: 'span' as const, panel, side: 'top' as const, index })),
    ...(n > 0 ? [{ kind: 'columns' as const }] : []),
    ...props.spans.bottom.map((panel, index) => ({ kind: 'span' as const, panel, side: 'bottom' as const, index })),
  ];
  const fullLines = props.spans.top.length + 1 + props.spans.bottom.length;
  const lineSizes = (() => {
    const saved = props.spanSizes && props.spanSizes.length === fullLines ? props.spanSizes : null;
    // As linhas guardadas incluem sempre a das colunas (mesmo sem colunas, ela só não aparece).
    const all = saved ?? Array(fullLines).fill(1 / fullLines);
    return n > 0 ? all : all.filter((_, i) => i !== props.spans.top.length);
  })();

  const resize = (index: number) => (clientX: number) => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;
    const total = rect.width - SPLITTER * (n - 1);
    const offset = clientX - rect.left - SPLITTER * (index + 0.5);
    props.onResize(resizeEqualized(n, index, Math.min(Math.max(offset / total, 0), 1)));
  };

  const resizeStack = (column: PanelColumn, row: number, el: HTMLElement | null) => (_x: number, clientY: number) => {
    const rect = el?.getBoundingClientRect();
    if (!rect) return;
    const m = column.length;
    const total = rect.height - SPLITTER * (m - 1);
    const offset = clientY - rect.top - SPLITTER * (row + 0.5);
    props.onStackResize(column.join('+'), resizeEqualized(m, row, Math.min(Math.max(offset / total, 0), 1)));
  };

  /** Divisória entre linhas da faixa: a linha de cima fica com a altura marcada, as outras dividem o resto. */
  const resizeLines = (index: number) => (_x: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const m = lines.length;
    const total = rect.height - SPLITTER * (m - 1);
    const offset = clientY - rect.top - SPLITTER * (index + 0.5);
    const visible = resizeEqualized(m, index, Math.min(Math.max(offset / total, 0), 1));
    // Guarda no formato completo (com a linha das colunas, mesmo que ela não esteja aparecendo).
    props.onSpanResize(n > 0 ? visible : [...visible.slice(0, props.spans.top.length), 1 / fullLines, ...visible.slice(props.spans.top.length)]);
  };

  // Só o título da área inicia o arrasto para reordenar (o resto da área continua clicável e selecionável).
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const head = t.closest('.panel-head, .stage-head');
    const control = t.closest('button:not(.panel-toggle), input, select, textarea, a, [role="menu"]');
    e.currentTarget.draggable = Boolean(head && !control);
  };

  /** Borda de cima/de baixo da faixa inteira (vale mais que o lado da área embaixo do ponteiro). */
  const edgeAt = (e: DragEvent<HTMLDivElement>): 'top' | 'bottom' | null => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return null;
    if (e.clientY - r.top < SPAN_EDGE) return 'top';
    if (r.bottom - e.clientY < SPAN_EDGE) return 'bottom';
    return null;
  };

  const sideAt = (e: DragEvent<HTMLDivElement>, span: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ry = (e.clientY - r.top) / r.height;
    // Área da largura toda não tem "ao lado": só acima ou abaixo dela.
    if (span) return ry < 0.5 ? 'top' : 'bottom';
    return dropSide((e.clientX - r.left) / r.width, ry);
  };

  const item = (panel: PanelId, onDropSide: (moved: PanelId, side: DropSide) => void, span: boolean) => (
    <div
      className={`zone-item ${drop?.panel === panel ? `drop-${drop.side}` : ''}`}
      data-panel={panel}
      onPointerDown={onPointerDown}
      onDragStart={(e) => {
        if (!e.currentTarget.draggable) return;
        e.dataTransfer.setData(DRAG_TYPE, panel);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.classList.add('zone-item-dragging');
      }}
      onDragEnd={(e) => {
        e.currentTarget.draggable = false;
        e.currentTarget.classList.remove('zone-item-dragging');
        setDrop(null);
        setSpanDrop(null);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const edge = edgeAt(e);
        if (edge) {
          if (drop) setDrop(null);
          if (spanDrop !== edge) setSpanDrop(edge);
          return;
        }
        if (spanDrop) setSpanDrop(null);
        const side = sideAt(e, span);
        if (drop?.panel !== panel || drop.side !== side) setDrop({ panel, side });
      }}
      onDrop={(e) => {
        const moved = e.dataTransfer.getData(DRAG_TYPE) as PanelId;
        const edge = edgeAt(e);
        const side = sideAt(e, span);
        setDrop(null);
        setSpanDrop(null);
        if (!moved) return;
        if (edge) props.onMove(moved, { kind: 'span', zone: props.zone, side: edge, at: edge === 'top' ? 0 : props.spans.bottom.length });
        else onDropSide(moved, side);
      }}
    >
      {props.render(panel)}
    </div>
  );

  const columnsRow = (
    <div ref={rowRef} className="zone-row-inner">
      {props.columns.map((column, i) => {
        const key = column.join('+');
        const rows = props.stackSizes[key]?.length === column.length ? props.stackSizes[key] : column.map(() => 1 / column.length);
        return (
          <div key={key} className="zone-cell" style={{ flex: `${fractions[i] ?? 1 / n} 1 0` }}>
            <div className="zone-stack">
              {column.map((panel, j) => (
                <div key={panel} className="zone-stack-cell" style={{ flex: `${rows[j] ?? 1 / column.length} 1 0` }}>
                  {item(panel, (moved, side) => {
                    if (side === 'left' || side === 'right') props.onMove(moved, { kind: 'column', zone: props.zone, index: side === 'right' ? i + 1 : i });
                    else props.onMove(moved, { kind: 'stack', anchor: panel, below: side === 'bottom' });
                  }, false)}
                  {j < column.length - 1 && (
                    <div
                      className="zone-splitter"
                      data-dir="col"
                      role="separator"
                      onPointerDown={(e) => startDrag(e, resizeStack(column, j, (e.currentTarget.parentElement?.parentElement ?? null) as HTMLElement | null))}
                    />
                  )}
                </div>
              ))}
            </div>
            {i < n - 1 && (
              <div
                className="zone-splitter"
                data-dir="row"
                role="separator"
                onPointerDown={(e) => startDrag(e, resize(i))}
              />
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <div
      ref={ref}
      className={`zone zone-lines ${spanDrop ? `zone-drop-span-${spanDrop}` : ''}`}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDrop(null); setSpanDrop(null); } }}
    >
      {spanDrop && <div className={`zone-span-hint zone-span-hint-${spanDrop}`} aria-hidden="true">Largura toda</div>}
      {lines.map((line, k) => (
        <div key={line.kind === 'columns' ? 'colunas' : `span:${line.panel}`} className={`zone-line ${line.kind === 'span' ? 'zone-line-span' : ''}`} style={{ flex: `${lineSizes[k] ?? 1 / lines.length} 1 0` }}>
          {line.kind === 'columns' ? columnsRow : item(line.panel, (moved, side) => props.onMove(moved, { kind: 'stack', anchor: line.panel, below: side === 'bottom' }), true)}
          {k < lines.length - 1 && (
            <div className="zone-splitter" data-dir="col" role="separator" onPointerDown={(e) => startDrag(e, resizeLines(k))} />
          )}
        </div>
      ))}
    </div>
  );
}
