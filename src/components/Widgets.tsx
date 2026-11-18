import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { ChevronDown, ChevronRight, ChevronsUp, ChevronUp, Eye, EyeOff, Folder, FolderOpen, FolderPlus, Globe, GripVertical, Link2, Pencil, Pipette, Plus, RotateCcw, Scan, Trash2 } from 'lucide-react';
import { pageRegistry, pool, usePooledStream } from '../devices/pool';
import { ChromaKeyer } from '../program/chroma';
import { FrameReader } from '../program/frames';
import { DEFAULT_CHROMA, type PageScroll, type SceneFolder, type WebPage } from '../types/studio';
import { moveWidget, moveWidgetFolder, removeWidgetFolder, widgetRows, type DropTarget } from '../utils/folders';
import { validPageUrl } from '../utils/validate';
import { Modal, StatusTag } from './common';

const SIZES = [
  { label: '1920×1080 (Full HD)', width: 1920, height: 1080 },
  { label: '1280×720 (HD)', width: 1280, height: 720 },
  { label: '1080×1920 (vertical)', width: 1080, height: 1920 },
  { label: '800×600', width: 800, height: 600 },
];

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
type Region = NonNullable<WebPage['region']>;
type Drag = { mode: 'new' | 'move' | 'nw' | 'ne' | 'sw' | 'se'; start: { x: number; y: number }; r0: Region };

/**
 * Prévia ao vivo da página: mostra a página inteira, a área escolhida (o resto escurecido) e,
 * com o fundo removido, o resultado sobre um quadriculado. Com o conta-gotas, um clique escolhe a cor.
 */
function WidgetPreview({ page, picking, onRegion, onPick, onScroll }: { page: WebPage; picking: boolean; onRegion: (r: Region | null) => void; onPick: (hex: string) => void; onScroll: (s: PageScroll) => void }) {
  const pooled = usePooledStream({ kind: 'video', deviceId: `pagina:${page.id}`, label: page.name, constraints: {} });
  const track = pooled.stream?.getVideoTracks()[0] ?? null;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const reader = useRef<FrameReader | null>(null);
  const keyer = useRef<ChromaKeyer | null>(null);
  const drag = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const latestPage = useRef(page);
  latestPage.current = page;

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([e]) => {
      const aspect = latestPage.current.width / latestPage.current.height;
      const { width, height } = e.contentRect;
      setSize(width / height > aspect ? { w: height * aspect, h: height } : { w: width, h: width / aspect });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [page.width, page.height]);

  useEffect(() => {
    if (!track) return;
    const r = new FrameReader(track);
    reader.current = r;
    return () => {
      r.stop();
      if (reader.current === r) reader.current = null;
    };
  }, [track]);

  useEffect(() => {
    keyer.current = new ChromaKeyer();
    let frame = requestAnimationFrame(function draw() {
      const c = canvas.current;
      const latest = reader.current?.latest;
      if (c && latest) {
        if (c.width !== latest.videoWidth || c.height !== latest.videoHeight) {
          c.width = latest.videoWidth;
          c.height = latest.videoHeight;
        }
        const g = c.getContext('2d')!;
        const p = latestPage.current;
        if (p.chroma.enabled) {
          // Quadriculado: o que ficar visível através dele é o que some no programa.
          const s = 24;
          for (let y = 0; y < c.height; y += s) for (let x = 0; x < c.width; x += s) {
            g.fillStyle = ((x + y) / s) % 2 ? '#3a3d42' : '#2a2d31';
            g.fillRect(x, y, s, s);
          }
          g.drawImage(keyer.current?.process(latest, p.chroma) ?? latest, 0, 0);
        } else {
          g.drawImage(latest, 0, 0);
        }
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
      keyer.current?.dispose();
    };
  }, []);

  const toFrac = (e: { clientX: number; clientY: number }) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };

  const pick = (e: ReactPointerEvent) => {
    const latest = reader.current?.latest;
    if (!latest) return;
    const p = toFrac(e);
    // Lê a cor real da página (não a tela, que está escurecida fora da área): média de 3×3 pixels.
    const probe = document.createElement('canvas');
    probe.width = 3;
    probe.height = 3;
    const g = probe.getContext('2d', { willReadFrequently: true })!;
    const sx = clamp(Math.floor(p.x * latest.videoWidth) - 1, 0, latest.videoWidth - 3);
    const sy = clamp(Math.floor(p.y * latest.videoHeight) - 1, 0, latest.videoHeight - 3);
    g.drawImage(latest, sx, sy, 3, 3, 0, 0, 3, 3);
    const data = g.getImageData(0, 0, 3, 3).data;
    const avg = [0, 1, 2].map((c) => Math.round([0, 1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, i) => sum + data[i * 4 + c], 0) / 9));
    onPick(`#${avg.map((n) => n.toString(16).padStart(2, '0')).join('')}`);
  };

  const begin = (e: ReactPointerEvent<HTMLElement>, mode: Drag['mode']) => {
    e.stopPropagation();
    if (picking) {
      pick(e);
      return;
    }
    overlay.current!.setPointerCapture(e.pointerId);
    const p = toFrac(e);
    drag.current = { mode, start: p, r0: page.region ?? { x: p.x, y: p.y, w: 0, h: 0 } };
    if (mode === 'new') drag.current.r0 = { x: p.x, y: p.y, w: 0, h: 0 };
  };

  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toFrac(e);
    const { r0 } = d;
    let r: Region;
    if (d.mode === 'new') {
      r = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
    } else if (d.mode === 'move') {
      r = { ...r0, x: clamp(r0.x + p.x - d.start.x, 0, 1 - r0.w), y: clamp(r0.y + p.y - d.start.y, 0, 1 - r0.h) };
    } else {
      const left = d.mode.includes('w') ? p.x : r0.x;
      const right = d.mode.includes('e') ? p.x : r0.x + r0.w;
      const top = d.mode.includes('n') ? p.y : r0.y;
      const bottom = d.mode.includes('s') ? p.y : r0.y + r0.h;
      r = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(bottom - top) };
    }
    if (r.w > 0.01 && r.h > 0.01) onRegion(r);
  };

  // Rodinha (ou dois dedos no trackpad) sobre a prévia: rola a página de verdade, no ponto do ponteiro.
  const pendingScroll = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const wheel = (e: ReactWheelEvent) => {
    const p = toFrac(e);
    const q = pendingScroll.current ?? { x: p.x * page.width, y: p.y * page.height, dx: 0, dy: 0 };
    q.dx += e.deltaX;
    q.dy += e.deltaY;
    if (pendingScroll.current) return;
    pendingScroll.current = q;
    requestAnimationFrame(() => {
      const send = pendingScroll.current;
      pendingScroll.current = null;
      if (send) void window.studio.scrollPage(page.id, send.x, send.y, send.dx, send.dy).then((pos) => pos && onScroll(pos));
    });
  };

  /** Botões de rolagem (para quem não usa rodinha): rola no centro da página. */
  const step = (dy: number) => {
    void window.studio.scrollPage(page.id, page.width / 2, page.height / 2, 0, dy).then((pos) => pos && onScroll(pos));
  };

  const region = page.region;
  return (
    <div className="widget-preview" ref={box}>
      <div className="widget-scroll-btns">
        <button type="button" className="btn btn-small btn-icon" data-tip="Voltar ao topo" aria-label="Voltar ao topo" onClick={() => step(-100000)}><ChevronsUp size={14} /></button>
        <button type="button" className="btn btn-small btn-icon" data-tip="Rolar para cima" aria-label="Rolar para cima" onClick={() => step(-Math.round(page.height * 0.4))}><ChevronUp size={14} /></button>
        <button type="button" className="btn btn-small btn-icon" data-tip="Rolar para baixo" aria-label="Rolar para baixo" onClick={() => step(Math.round(page.height * 0.4))}><ChevronDown size={14} /></button>
      </div>
      <div className="widget-stage" style={{ width: size.w, height: size.h }}>
        <canvas ref={canvas} />
        {pooled.status !== 'ativo' && <div className="video-status"><strong>{pooled.status === 'abrindo' ? 'Carregando a página…' : pooled.error ?? 'Página indisponível'}</strong></div>}
        <div
          ref={overlay}
          className={`widget-overlay ${picking ? 'widget-picking' : ''}`}
          onPointerDown={(e) => begin(e, 'new')}
          onPointerMove={move}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onWheel={wheel}
        >
          {region && (
            <div className="widget-region" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }} onPointerDown={(e) => begin(e, 'move')}>
              {(['nw', 'ne', 'sw', 'se'] as const).map((h) => <i key={h} className={`handle handle-${h}`} onPointerDown={(e) => begin(e, h)} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Criar ou editar um widget: endereço, tamanho, área exibida e remoção do fundo. */
export function WidgetDialog({ page, onSave, onClose }: { page: WebPage | null; onSave: (page: WebPage) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<WebPage>(() => page ?? { id: crypto.randomUUID(), name: '', url: 'https://', width: 1280, height: 720, region: null, chroma: { ...DEFAULT_CHROMA } });
  const [loaded, setLoaded] = useState<WebPage | null>(page);
  const [picking, setPicking] = useState(false);
  const [hexDraft, setHexDraft] = useState(() => (page?.chroma.color ?? DEFAULT_CHROMA.color).toUpperCase());
  const fixed = draft.url.trim() && !/^https?:\/\//i.test(draft.url.trim()) ? `https://${draft.url.trim()}` : draft.url.trim();
  const valid = validPageUrl(fixed) && draft.width >= 160 && draft.width <= 3840 && draft.height >= 120 && draft.height <= 2160;
  const preset = SIZES.findIndex((s) => s.width === draft.width && s.height === draft.height);
  const changedPage = loaded && (loaded.url !== fixed || loaded.width !== draft.width || loaded.height !== draft.height);

  /** Abre (ou reabre) a página com o endereço e o tamanho do formulário. */
  const load = async () => {
    if (!valid) return;
    const next = { ...draft, url: fixed, name: draft.name.trim() || domainOf(fixed) };
    setDraft(next);
    pageRegistry.set(next.id, next);
    await window.studio.openPage(next);
    pool.list().filter((e) => e.spec.deviceId === `pagina:${next.id}`).forEach((e) => pool.retry(e.key));
    setLoaded(next);
  };

  const close = () => {
    // Widget novo descartado: fecha a janela escondida da página.
    if (!page && loaded) {
      pageRegistry.delete(draft.id);
      void window.studio.closePage(draft.id);
    }
    onClose();
  };

  const chroma = draft.chroma;
  const setChroma = (patch: Partial<WebPage['chroma']>) => setDraft((d) => ({ ...d, chroma: { ...d.chroma, ...patch } }));
  return (
    <Modal title={page ? `Widget · ${page.name}` : 'Novo widget'} onClose={close} wide>
      <div className="widget-layout">
        <div className="widget-left">
          {loaded ? (
            <WidgetPreview page={{ ...loaded, region: draft.region, chroma: draft.chroma }} picking={picking} onRegion={(region) => setDraft((d) => ({ ...d, region }))} onPick={(color) => { setChroma({ color, enabled: true }); setHexDraft(color.toUpperCase()); setPicking(false); }} onScroll={(scroll) => setDraft((d) => ({ ...d, scroll }))} />
          ) : (
            <div className="widget-empty"><Globe size={28} /><p>Cole o endereço da página e clique em <b>Abrir página</b>.</p></div>
          )}
        </div>
        <div className="settings-form">
          <label className="option-field">
            <span className="option-label">Endereço da página</span>
            <div className="link-row">
              <input className="field" value={draft.url} autoFocus={!page} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://placar.exemplo.com" />
              <button type="button" className={`btn btn-small ${!loaded || changedPage ? 'btn-primary' : ''}`} disabled={!valid} onClick={() => void load()}>{loaded ? 'Atualizar' : 'Abrir página'}</button>
            </div>
          </label>
          <label className="option-field">
            <span className="option-label">Nome</span>
            <input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={valid ? domainOf(fixed) : 'Ex.: Placar'} maxLength={120} />
          </label>
          <label className="option-field">
            <span className="option-label">Tamanho da página</span>
            <select className="option-select" value={preset >= 0 ? preset : 'custom'} onChange={(e) => {
              const s = SIZES[Number(e.target.value)];
              if (s) setDraft({ ...draft, width: s.width, height: s.height });
            }}>
              {SIZES.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
              <option value="custom">Personalizado</option>
            </select>
          </label>
          <div className="size-row">
            <label className="option-field"><span className="option-label">Largura</span><input className="field" type="number" min={160} max={3840} value={draft.width} onChange={(e) => setDraft({ ...draft, width: Number(e.target.value) })} /></label>
            <label className="option-field"><span className="option-label">Altura</span><input className="field" type="number" min={120} max={2160} value={draft.height} onChange={(e) => setDraft({ ...draft, height: Number(e.target.value) })} /></label>
          </div>
          {changedPage && <p className="hint">Clique em <b>Atualizar</b> para aplicar o novo endereço ou tamanho.</p>}
          <label className="switch-row" data-tip="Marcado: o som da página aparece no mixer e vai para a transmissão. Desmarcado: o widget é só imagem.">
            <span>Widget com som (vai para o mixer)</span>
            <input type="checkbox" className="switch" checked={draft.audio === true} onChange={(e) => setDraft({ ...draft, audio: e.target.checked })} />
          </label>

          <h3 className="group-title">Área exibida</h3>
          <div className="row-actions">
            <span className="hint">{draft.region ? `Parte da página (${Math.round(draft.region.w * draft.width)}×${Math.round(draft.region.h * draft.height)})` : 'Página inteira'}</span>
            <button type="button" className="btn btn-small" disabled={!draft.region} onClick={() => setDraft({ ...draft, region: null })}><Scan size={13} /> Página inteira</button>
          </div>

          <h3 className="group-title">Remover fundo</h3>
          <label className="switch-row">
            <span>Remover uma cor (chroma key)</span>
            <input type="checkbox" className="switch" checked={chroma.enabled} onChange={(e) => setChroma({ enabled: e.target.checked })} />
          </label>
          <div className="chroma-row">
            {/* O quadrado liga o conta-gotas do app: o seletor do macOS lia a tela (escurecida), não a página. */}
            <button type="button" className="chroma-swatch" style={{ background: chroma.color }} disabled={!loaded} onClick={() => setPicking(true)} title="Escolher a cor clicando na página" aria-label={`Cor do fundo ${chroma.color}`} />
            <input className="field chroma-hex-field" value={hexDraft} maxLength={7} spellCheck={false} aria-label="Código da cor" onChange={(e) => {
              setHexDraft(e.target.value);
              const v = e.target.value.trim();
              if (/^#?[0-9a-fA-F]{6}$/.test(v)) setChroma({ color: `#${v.replace('#', '').toLowerCase()}`, enabled: true });
            }} />
            <button type="button" className={`btn btn-small ${picking ? 'btn-on' : ''}`} disabled={!loaded} onClick={() => setPicking(!picking)}><Pipette size={13} /> {picking ? 'Clique na prévia' : 'Conta-gotas'}</button>
          </div>
          <label className="option-field">
            <span className="option-label">Tolerância <output>{Math.round(chroma.similarity * 100)}%</output></span>
            <input type="range" min={0} max={0.8} step={0.01} value={chroma.similarity} disabled={!chroma.enabled} onChange={(e) => setChroma({ similarity: Number(e.target.value) })} />
          </label>
          <label className="option-field">
            <span className="option-label">Suavidade da borda <output>{Math.round(chroma.smoothness * 100)}%</output></span>
            <input type="range" min={0} max={0.4} step={0.01} value={chroma.smoothness} disabled={!chroma.enabled} onChange={(e) => setChroma({ smoothness: Number(e.target.value) })} />
          </label>
        </div>
      </div>
      <div className="modal-actions">
        {loaded && <p className="hint widget-hint">{picking ? 'Clique na cor de fundo que deve sumir.' : 'Rodinha (ou dois dedos) ou as setas no canto: rolar a página. Arraste sobre ela para escolher a parte que aparece; arraste a seleção para mover e os cantos para ajustar.'}</p>}
        <button type="button" className="btn" onClick={close}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={!loaded || Boolean(changedPage)} onClick={() => onSave({ ...draft, url: loaded!.url, width: loaded!.width, height: loaded!.height, name: draft.name.trim() || domainOf(loaded!.url) })}>
          {page ? 'Salvar widget' : 'Criar widget'}
        </button>
      </div>
    </Modal>
  );
}

interface PanelProps {
  pages: WebPage[];
  previewIds: Set<string>;
  onNew: () => void;
  onEdit: (page: WebPage) => void;
  onPreview: (page: WebPage) => void;
  onAdd: (page: WebPage) => void;
  onReload: (page: WebPage) => void;
  onRemove: (page: WebPage) => void;
  /** Clicar no widget seleciona ele no Programa (se estiver na cena no ar). */
  onSelect: (page: WebPage) => void;
  /** Widget selecionado no Programa (destacado na lista). */
  selectedPageId: string | null;
  /** Pastas da lista de widgets. */
  folders: SceneFolder[];
  /** Nova ordem dos widgets e/ou das pastas (arrastar, criar, renomear, apagar pasta). */
  onListChange: (pages: WebPage[], folders: SceneFolder[]) => void;
  /** Troca o endereço dos widgets escolhidos (área, fundo e tamanho continuam os mesmos). */
  onSetLink: (pageIds: string[], url: string) => void;
}

const fixUrl = (url: string) => {
  const t = url.trim();
  return t && !/^https?:\/\//i.test(t) ? `https://${t}` : t;
};

/** Novo link para vários widgets de uma vez (ex.: o placar do próximo jogo, no mesmo lugar e com o mesmo recorte). */
function LinkDialog({ pages, onApply, onClose }: { pages: WebPage[]; onApply: (ids: string[], url: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState('https://');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const fixed = fixUrl(url);
  const valid = validPageUrl(fixed);
  const all = pages.length > 0 && chosen.size === pages.length;
  const toggle = (id: string) => setChosen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <Modal title="Novo link para os widgets" onClose={onClose}>
      <label className="option-field">
        <span className="option-label">Novo link</span>
        <input className="field" value={url} autoFocus onChange={(e) => setUrl(e.target.value)} placeholder="https://placar.exemplo.com/jogo" onFocus={(e) => e.currentTarget.select()} />
      </label>
      {url.trim() && url.trim() !== 'https://' && !valid && <p className="hint">Endereço inválido: use um link que comece com https:// ou http://.</p>}
      <div className="link-pick-head">
        <span className="option-label">Inserir o link em</span>
        <button type="button" className="link-btn" disabled={pages.length === 0} onClick={() => setChosen(all ? new Set() : new Set(pages.map((p) => p.id)))}>{all ? 'Desmarcar todos' : 'Marcar todos'}</button>
      </div>
      {pages.length === 0 ? (
        <p className="empty-text">Nenhum widget cadastrado ainda.</p>
      ) : (
        <ul className="link-pick">
          {pages.map((page) => (
            <li key={page.id}>
              <label className={`link-pick-row ${chosen.has(page.id) ? 'link-pick-on' : ''}`}>
                <input type="checkbox" checked={chosen.has(page.id)} onChange={() => toggle(page.id)} />
                <Globe size={14} />
                <span className="link-pick-name">{page.name}</span>
                <span className="link-pick-url" title={page.url}>{domainOf(page.url)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">A área escolhida, o fundo removido e o tamanho de cada widget continuam iguais; só a página muda.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={!valid || chosen.size === 0} onClick={() => { onApply([...chosen], fixed); onClose(); }}>
          {chosen.size > 1 ? `Inserir em ${chosen.size} widgets` : 'Inserir link'}
        </button>
      </div>
    </Modal>
  );
}

/** Widgets criados, no mesmo formato dos dispositivos: cartões recolhidos que abrem ao clicar. Podem ficar em pastas. */
export function WidgetsPanel(props: PanelProps) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [linking, setLinking] = useState(false);
  const [drag, setDrag] = useState<{ kind: 'page' | 'folder'; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  useSyncExternalStore(pool.subscribe, pool.getVersion);
  const { pages, folders } = props;

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };
  const apply = () => {
    const d = drag;
    const target = dropAt;
    endDrag();
    if (!d || !target) return;
    if (d.kind === 'page') props.onListChange(moveWidget(pages, folders, d.id, target), folders);
    else {
      const next = moveWidgetFolder(pages, folders, d.id, target);
      props.onListChange(next.pages, next.folders);
    }
  };
  const setFolder = (id: string, patch: Partial<SceneFolder>) => props.onListChange(pages, folders.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const newFolder = () => {
    const folder: SceneFolder = { id: crypto.randomUUID(), name: `PASTA ${folders.length + 1}`, collapsed: false };
    props.onListChange(pages, [folder, ...folders]);
    setEditingFolder(folder.id);
    setFolderName(folder.name);
  };
  const toggle = (id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const renderPage = (page: WebPage, inFolder: boolean) => {
    const entries = pool.list().filter((e) => e.spec.deviceId === `pagina:${page.id}`);
    const status = entries.some((e) => e.status === 'ativo') ? 'ativo' : entries.some((e) => e.status === 'falhou') ? 'falhou' : entries.some((e) => e.status === 'abrindo') ? 'abrindo' : 'conectado';
    const expanded = open.has(page.id);
    const marker = dropAt?.kind === 'item' && dropAt.id === page.id && drag?.id !== page.id ? (dropAt.after ? 'drop-after' : 'drop-before') : '';
    return (
      <li
        key={page.id}
        className={`device-card widget-card ${inFolder ? 'widget-in-folder' : ''} ${expanded ? 'device-card-open' : ''} ${props.previewIds.has(`pagina:${page.id}`) ? 'device-card-on' : ''} ${drag?.kind === 'page' && drag.id === page.id ? 'widget-dragging' : ''} ${props.selectedPageId === page.id ? 'widget-selected' : ''} ${marker}`}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData('text/plain', page.id);
          e.dataTransfer.effectAllowed = 'move';
          setDrag({ kind: 'page', id: page.id });
        }}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          if (dropAt?.kind !== 'item' || dropAt.id !== page.id || dropAt.after !== after) setDropAt({ kind: 'item', id: page.id, after });
        }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); apply(); }}
        onDragEnd={endDrag}
      >
        {/* Só a setinha abre/fecha os detalhes; clicar no resto do cartão seleciona o widget no Programa. */}
        <div className="widget-head-row">
          <GripVertical size={14} className="widget-grip" />
          <button
            type="button"
            className="icon-btn widget-expand"
            aria-expanded={expanded}
            aria-label={expanded ? `Fechar detalhes de ${page.name}` : `Abrir detalhes de ${page.name}`}
            data-tip={expanded ? 'Fechar detalhes' : 'Abrir detalhes'}
            onClick={() => toggle(page.id)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <button type="button" className="device-head" onClick={() => props.onSelect(page)} title={page.url}>
            <span className="device-icon"><Globe size={15} /></span>
            <strong className="device-title">{page.name}</strong>
            <StatusTag status={status} />
          </button>
          <button
            type="button"
            className={`icon-btn row-eye ${props.previewIds.has(`pagina:${page.id}`) ? 'icon-btn-on' : ''}`}
            aria-label={props.previewIds.has(`pagina:${page.id}`) ? `Tirar ${page.name} da prévia` : `Pôr ${page.name} na prévia`}
            data-tip={props.previewIds.has(`pagina:${page.id}`) ? 'Tirar da prévia' : 'Pôr na prévia'}
            onClick={() => props.onPreview(page)}
          >
            {props.previewIds.has(`pagina:${page.id}`) ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {expanded && (
          <div className="device-body">
            <dl className="device-specs">
              <dt>Site</dt><dd title={page.url}>{domainOf(page.url)}</dd>
              <dt>Página</dt><dd>{page.width}×{page.height}</dd>
              <dt>Área</dt><dd>{page.region ? `${Math.round(page.region.w * page.width)}×${Math.round(page.region.h * page.height)} (parte)` : 'Inteira'}</dd>
              <dt>Fundo</dt><dd>{page.chroma.enabled ? <><span className="chroma-dot" style={{ background: page.chroma.color }} /> removido</> : 'Mantido'}</dd>
              <dt>Som</dt><dd>{page.audio ? 'Vai para o mixer' : 'Sem som (só imagem)'}</dd>
            </dl>
            <div className="device-actions">
              <button type="button" className={`btn btn-small ${props.previewIds.has(`pagina:${page.id}`) ? 'btn-on' : ''}`} onClick={() => props.onPreview(page)}>
                {props.previewIds.has(`pagina:${page.id}`) ? <EyeOff size={13} /> : <Eye size={13} />} {props.previewIds.has(`pagina:${page.id}`) ? 'Tirar da prévia' : 'Pôr na prévia'}
              </button>
              <button type="button" className="btn btn-small" onClick={() => props.onAdd(page)}><Plus size={13} /> Adicionar à cena</button>
              <span className="device-actions-right">
                <button type="button" className="icon-btn" title="Editar (área, fundo, endereço)" aria-label={`Editar ${page.name}`} onClick={() => props.onEdit(page)}><Pencil size={14} /></button>
                <button type="button" className="icon-btn" title="Recarregar a página" aria-label={`Recarregar ${page.name}`} onClick={() => props.onReload(page)}><RotateCcw size={14} /></button>
                <button type="button" className="icon-btn icon-btn-remove" title="Remover widget" aria-label={`Remover ${page.name}`} onClick={() => props.onRemove(page)}><Trash2 size={14} /></button>
              </span>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="panel widgets-panel" aria-label="Widgets">
      <header className="panel-head">
        <h2 className="panel-title">Widgets</h2>
        <span className="panel-head-actions">
          <button type="button" className="icon-btn" aria-label="Nova pasta de widgets" data-tip="Nova pasta: arraste widgets para dentro para organizar" onClick={newFolder}><FolderPlus size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Novo link para os widgets" data-tip="Novo link: trocar a página de um ou vários widgets" onClick={() => setLinking(true)}><Link2 size={15} /></button>
          <button type="button" className="btn btn-small btn-primary" onClick={props.onNew}><Plus size={13} /> Novo widget</button>
        </span>
      </header>
      {linking && <LinkDialog pages={pages} onApply={props.onSetLink} onClose={() => setLinking(false)} />}
      <div className="panel-scroll">
        {pages.length === 0 && folders.length === 0 && <p className="empty-text">Traga um placar, gráfico ou qualquer página de outro site: escolha a parte que aparece e remova o fundo.</p>}
        <ul className="device-list">
          {widgetRows(pages, folders).map((row) => {
            if (row.kind === 'page') return renderPage(row.page, false);
            const { folder } = row;
            const marker = dropAt?.kind === 'folder' && dropAt.id === folder.id ? `folder-drop-${dropAt.zone}` : '';
            return (
              <li key={`pasta:${folder.id}`} className={`source-folder widget-folder ${drag?.kind === 'folder' && drag.id === folder.id ? 'source-dragging' : ''}`}>
                <div
                  className={`folder-head ${marker}`}
                  draggable={editingFolder !== folder.id}
                  onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'folder', id: folder.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', folder.id); }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    const y = (e.clientY - r.top) / r.height;
                    const zone = drag.kind === 'page' ? (y < 0.25 ? 'before' : y > 0.75 && folder.collapsed ? 'after' : 'inside') : y < 0.5 ? 'before' : 'after';
                    if (dropAt?.kind !== 'folder' || dropAt.id !== folder.id || dropAt.zone !== zone) setDropAt({ kind: 'folder', id: folder.id, zone });
                  }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); apply(); }}
                >
                  <GripVertical size={13} className="grip" />
                  <button type="button" className="icon-btn folder-toggle" aria-expanded={!folder.collapsed} aria-label={folder.collapsed ? `Abrir a pasta ${folder.name}` : `Fechar a pasta ${folder.name}`} data-tip={folder.collapsed ? 'Abrir pasta' : 'Fechar pasta'} onClick={() => setFolder(folder.id, { collapsed: !folder.collapsed })}>
                    {folder.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {folder.collapsed ? <Folder size={14} className="folder-icon" /> : <FolderOpen size={14} className="folder-icon" />}
                  {editingFolder === folder.id ? (
                    <form className="scene-edit" onSubmit={(e) => { e.preventDefault(); if (folderName.trim()) setFolder(folder.id, { name: folderName.trim().slice(0, 120) }); setEditingFolder(null); }}>
                      <input className="field" value={folderName} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setFolderName(e.target.value)} aria-label="Nome da pasta" onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
                    </form>
                  ) : (
                    <span className="source-name folder-name" onDoubleClick={() => { setEditingFolder(folder.id); setFolderName(folder.name); }}>
                      {folder.name} <small>· {row.pages.length} {row.pages.length === 1 ? 'widget' : 'widgets'}</small>
                    </span>
                  )}
                  <button type="button" className="icon-btn" aria-label={`Renomear a pasta ${folder.name}`} data-tip="Renomear pasta" onClick={() => { setEditingFolder(folder.id); setFolderName(folder.name); }}><Pencil size={13} /></button>
                  <button type="button" className="icon-btn icon-btn-remove" aria-label={`Apagar a pasta ${folder.name}`} data-tip="Apagar a pasta (os widgets continuam na lista)" onClick={() => { const next = removeWidgetFolder(pages, folders, folder.id); props.onListChange(next.pages, next.folders); }}><Trash2 size={13} /></button>
                </div>
                {!folder.collapsed && (
                  <ul className="device-list folder-children widget-folder-children">
                    {row.pages.length === 0 ? <li className="folder-empty">Arraste widgets para cá</li> : row.pages.map((page) => renderPage(page, true))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
