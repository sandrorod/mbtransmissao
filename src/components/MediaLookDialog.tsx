import { useState, type CSSProperties } from 'react';
import { RotateCcw } from 'lucide-react';
import { effectsFilter } from '../program/compositor';
import { BORDER_STYLES, DEFAULT_MEDIA_EFFECTS, DEFAULT_MEDIA_LOOK, mediaUrl, type BorderStyle, type MediaEffects, type MediaItem, type MediaLook } from '../types/studio';
import { Modal } from './common';

/** Estilo sem nada (a mídia aparece como foi carregada)? */
export const isPlainLook = (look: MediaLook) => JSON.stringify(look) === JSON.stringify(DEFAULT_MEDIA_LOOK);

const clone = (look: MediaLook): MediaLook => JSON.parse(JSON.stringify(look)) as MediaLook;
const SWATCHES = ['#ffffff', '#000000', '#2ec4b6', '#ffd400', '#ff3b30', '#3478f6'];
/** Estilos de borda da mídia (a "sombra" aqui é separada). */
const STYLES = (Object.entries(BORDER_STYLES) as [BorderStyle, string][]).filter(([k]) => k !== 'sombra');
const CSS_BORDER: Record<BorderStyle, string> = { solida: 'solid', tracejada: 'dashed', pontilhada: 'dotted', dupla: 'double', neon: 'solid', sombra: 'solid' };

const PRESETS: { name: string; look: MediaLook }[] = [
  { name: 'Sem estilo', look: DEFAULT_MEDIA_LOOK },
  { name: 'Moldura branca', look: { ...DEFAULT_MEDIA_LOOK, border: { style: 'solida', color: '#ffffff', width: 8 }, radius: 0 } },
  { name: 'Cartão', look: { ...DEFAULT_MEDIA_LOOK, radius: 24, shadow: { color: '#000000', blur: 30, distance: 10 } } },
  { name: 'Neon', look: { ...DEFAULT_MEDIA_LOOK, border: { style: 'neon', color: '#2ec4b6', width: 6 }, radius: 16 } },
  { name: 'Redondo', look: { ...DEFAULT_MEDIA_LOOK, radius: 200, border: { style: 'solida', color: '#ffffff', width: 6 } } },
  { name: 'Preto e branco', look: { ...DEFAULT_MEDIA_LOOK, effects: { ...DEFAULT_MEDIA_EFFECTS, grayscale: 100, contrast: 115 } } },
  { name: 'Marca d’água', look: { ...DEFAULT_MEDIA_LOOK, opacity: 0.5 } },
];

function Slider({ label, value, min, max, step = 1, unit = '', onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className="option-field">
      <span className="option-label">{label} <output>{Math.round(value)}{unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function ColorPick({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <span className="look-colors">
      {SWATCHES.map((c) => <button key={c} type="button" className={`border-color ${value.toLowerCase() === c ? 'border-color-on' : ''}`} style={{ background: c }} aria-label={`${label} ${c}`} onClick={() => onChange(c)} />)}
      <input type="color" className="look-color-input" value={value} aria-label={`${label}: outra cor`} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

/** Mostra a mídia com o estilo, na proporção de uma tela 1080p (as medidas encolhem como no Programa). */
function LookPreview({ item, look }: { item: MediaItem | null; look: MediaLook }) {
  const stageH = 234;
  const k = stageH / 1080;
  const b = look.border;
  const style: CSSProperties = {
    borderRadius: look.radius * k,
    opacity: look.opacity,
    filter: effectsFilter(look.effects, k) || undefined,
    boxShadow: [
      look.shadow ? `${look.shadow.distance * k}px ${look.shadow.distance * k}px ${look.shadow.blur * k}px ${look.shadow.color}` : '',
      b?.style === 'neon' ? `0 0 ${b.width * k * 2.5}px ${b.color}` : '',
    ].filter(Boolean).join(', ') || undefined,
    outline: b ? `${Math.max(1, b.width * k)}px ${CSS_BORDER[b.style]} ${b.color}` : undefined,
    outlineOffset: b ? -Math.max(1, b.width * k) : undefined,
  };
  return (
    <div className="look-stage" style={{ height: stageH }}>
      {!item ? <p className="hint">Carregue uma mídia para ver o estilo nela.</p>
        : item.kind === 'video' ? <video key={item.id} className="look-media" style={style} src={mediaUrl(item)} muted autoPlay loop playsInline />
          : <img key={item.id} className="look-media" style={style} src={mediaUrl(item)} alt={item.name} />}
    </div>
  );
}

interface Props {
  media: MediaItem[];
  /** Estilo padrão do projeto (vale para quem não tem estilo próprio). */
  defaultLook: MediaLook | undefined;
  /** Mídias já escolhidas ao abrir (vazio = aplicar a todas). */
  initialIds: string[];
  onApply: (look: MediaLook, target: 'all' | string[]) => void;
  /** Tira o estilo próprio: as mídias voltam a seguir o padrão. */
  onReset: (ids: string[]) => void;
  onClose: () => void;
}

/** Estilo das mídias: borda, cores, sombra, cantos e efeitos; para todas (inclusive as futuras) ou só para algumas. */
export function MediaLookDialog({ media, defaultLook, initialIds, onApply, onReset, onClose }: Props) {
  const [target, setTarget] = useState<'all' | 'some'>(initialIds.length ? 'some' : 'all');
  const [ids, setIds] = useState<Set<string>>(() => new Set(initialIds));
  const first = media.find((m) => ids.has(m.id));
  const [look, setLook] = useState<MediaLook>(() => clone((initialIds.length ? first?.look : undefined) ?? defaultLook ?? DEFAULT_MEDIA_LOOK));
  const set = (patch: Partial<MediaLook>) => setLook((l) => ({ ...l, ...patch }));
  const setFx = (patch: Partial<MediaEffects>) => setLook((l) => ({ ...l, effects: { ...l.effects, ...patch } }));
  const shown = target === 'some' ? first ?? null : media[0] ?? null;
  const chosen = media.filter((m) => ids.has(m.id));
  const own = chosen.filter((m) => m.look);
  const toggle = (id: string, on: boolean) => setIds((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const fxChanged = JSON.stringify(look.effects) !== JSON.stringify(DEFAULT_MEDIA_EFFECTS);

  return (
    <Modal title="Estilo das mídias" onClose={onClose} wide>
      <div className="look-layout">
        <div className="look-left">
          <LookPreview item={shown} look={look} />
          <h3 className="group-title">Estilos prontos</h3>
          <div className="look-presets">
            {PRESETS.map((p) => <button key={p.name} type="button" className={`btn btn-small ${JSON.stringify(p.look) === JSON.stringify(look) ? 'btn-on' : ''}`} onClick={() => setLook(clone(p.look))}>{p.name}</button>)}
          </div>
          <h3 className="group-title">Aplicar em</h3>
          <label className="look-target">
            <input type="radio" name="look-target" checked={target === 'all'} onChange={() => setTarget('all')} />
            <span><b>Todas as mídias</b>, inclusive as que forem carregadas depois</span>
          </label>
          <label className="look-target">
            <input type="radio" name="look-target" checked={target === 'some'} onChange={() => setTarget('some')} disabled={media.length === 0} />
            <span><b>Só nas escolhidas</b></span>
          </label>
          {target === 'some' && (
            <ul className="look-media-list">
              {media.map((m) => (
                <li key={m.id}>
                  <label>
                    <input type="checkbox" checked={ids.has(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
                    <span className="look-media-name" title={m.name}>{m.name}</span>
                    {m.look && <span className="look-own" title="Tem estilo próprio (não segue o padrão)">estilo próprio</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {target === 'all' && media.some((m) => m.look) && <p className="hint">As mídias com estilo próprio também passam a usar este.</p>}
        </div>

        <div className="settings-form look-form">
          <h3 className="group-title">Borda</h3>
          <label className="option-field">
            <span className="option-label">Tipo</span>
            <select className="option-select" value={look.border ? look.border.style : 'nenhuma'} onChange={(e) => set({ border: e.target.value === 'nenhuma' ? null : { color: look.border?.color ?? '#ffffff', width: look.border?.width ?? 6, style: e.target.value as BorderStyle } })}>
              <option value="nenhuma">Sem borda</option>
              {STYLES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          {look.border && (
            <>
              <div className="option-field"><span className="option-label">Cor da borda</span><ColorPick label="Cor da borda" value={look.border.color} onChange={(color) => set({ border: { ...look.border!, color } })} /></div>
              <Slider label="Espessura" value={look.border.width} min={1} max={40} unit=" px" onChange={(width) => set({ border: { ...look.border!, width } })} />
            </>
          )}
          <Slider label="Cantos arredondados" value={look.radius} min={0} max={200} unit=" px" onChange={(radius) => set({ radius })} />

          <h3 className="group-title">Sombra</h3>
          <label className="switch-row">
            <span>Sombra projetada</span>
            <input type="checkbox" className="switch" checked={Boolean(look.shadow)} onChange={(e) => set({ shadow: e.target.checked ? { color: '#000000', blur: 24, distance: 8 } : null })} />
          </label>
          {look.shadow && (
            <>
              <div className="option-field"><span className="option-label">Cor da sombra</span><ColorPick label="Cor da sombra" value={look.shadow.color} onChange={(color) => set({ shadow: { ...look.shadow!, color } })} /></div>
              <Slider label="Desfoque da sombra" value={look.shadow.blur} min={0} max={80} unit=" px" onChange={(blur) => set({ shadow: { ...look.shadow!, blur } })} />
              <Slider label="Distância" value={look.shadow.distance} min={0} max={60} unit=" px" onChange={(distance) => set({ shadow: { ...look.shadow!, distance } })} />
            </>
          )}

          <h3 className="group-title look-fx-title">
            Efeitos
            {fxChanged && <button type="button" className="btn btn-small" onClick={() => setLook((l) => ({ ...l, effects: { ...DEFAULT_MEDIA_EFFECTS } }))}><RotateCcw size={12} /> Zerar efeitos</button>}
          </h3>
          <Slider label="Opacidade" value={look.opacity * 100} min={5} max={100} unit="%" onChange={(v) => set({ opacity: v / 100 })} />
          <Slider label="Brilho" value={look.effects.brightness} min={0} max={200} unit="%" onChange={(brightness) => setFx({ brightness })} />
          <Slider label="Contraste" value={look.effects.contrast} min={0} max={200} unit="%" onChange={(contrast) => setFx({ contrast })} />
          <Slider label="Saturação (cores)" value={look.effects.saturation} min={0} max={200} unit="%" onChange={(saturation) => setFx({ saturation })} />
          <Slider label="Preto e branco" value={look.effects.grayscale} min={0} max={100} unit="%" onChange={(grayscale) => setFx({ grayscale })} />
          <Slider label="Sépia (foto antiga)" value={look.effects.sepia} min={0} max={100} unit="%" onChange={(sepia) => setFx({ sepia })} />
          <Slider label="Tom das cores" value={look.effects.hue} min={-180} max={180} unit="°" onChange={(hue) => setFx({ hue })} />
          <Slider label="Desfoque" value={look.effects.blur} min={0} max={30} unit=" px" onChange={(blur) => setFx({ blur })} />
        </div>
      </div>
      <div className="modal-actions">
        <p className="hint widget-hint">A borda posta pelo botão “Borda” do Programa vale mais que a borda do estilo naquela cena.</p>
        {target === 'some' && own.length > 0 && (
          <button type="button" className="btn" onClick={() => onReset(own.map((m) => m.id))} data-tip="Tira o estilo próprio: elas voltam a seguir o estilo de todas as mídias">Voltar ao padrão ({own.length})</button>
        )}
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={target === 'some' && chosen.length === 0} onClick={() => onApply(look, target === 'all' ? 'all' : chosen.map((m) => m.id))}>
          {target === 'all' ? 'Aplicar a todas' : `Aplicar em ${chosen.length} ${chosen.length === 1 ? 'mídia' : 'mídias'}`}
        </button>
      </div>
    </Modal>
  );
}
