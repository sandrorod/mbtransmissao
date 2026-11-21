import { useState } from 'react';
import { GripVertical, MonitorUp } from 'lucide-react';
import { SCENE_DRAG_TYPE } from './ScenesPanel';
import { AreaExpand } from './Layout';
import type { Compositor } from '../program/compositor';
import type { Border, LiveExtras, LiveStatus, OutputSettings, ProgramHud, SceneItem, Source, Transform, WebPage } from '../types/studio';
import { ProgramView, type MediaStyles } from './ProgramView';

interface PreviewProps {
  /** Elementos da Prévia, na ordem das camadas (o primeiro fica atrás). */
  sources: Source[];
  compositor: Compositor;
  pages: WebPage[];
  mediaStyles?: MediaStyles;
  output: OutputSettings;
  selectedId: string | null;
  /** No layout: só a imagem e o botão de expandir. Expandida: as ferramentas todas. */
  compact: boolean;
  /** Elementos que já estão na cena no ar. */
  inProgramIds: Set<string>;
  onSelect: (sourceId: string | null) => void;
  onTransform: (sourceId: string, transform: Transform | null) => void;
  onToggleFill: (sourceId: string) => void;
  onBorder: (sourceId: string, border: Border | null) => void;
  onPageRegion: (pageId: string, region: WebPage['region']) => void;
  onRemove: (sourceId: string) => void;
  onSendSelected: () => void;
  onSendAll: () => void;
  onExpand?: () => void;
}

const NO_HUD: ProgramHud = { quality: false, viewers: false, chat: false };

/**
 * Prévia: monta a cena antes de ir ao ar, com quantos elementos quiser e as mesmas ferramentas do Programa
 * (mover, tamanho, corte, tela cheia, centralizar). Os ajustes ficam guardados em cada fonte e vão junto
 * quando ela é colocada no Programa.
 */
export function PreviewPanel(props: PreviewProps) {
  const { sources, compact } = props;
  const items: SceneItem[] = sources.map((s) => ({ sourceId: s.id, transform: s.staged?.transform ?? null, hidden: false, ...(s.staged?.fill ? { fill: s.staged.fill } : {}), ...(s.staged?.border ? { border: s.staged.border } : {}) }));
  const selected = sources.find((s) => s.id === props.selectedId) ?? null;
  return (
    <section className={`stage-box ${compact ? 'preview-compact' : ''}`} aria-label="Prévia">
      <header className="stage-head">
        {compact && <GripVertical size={14} className="grip" />}
        <span className="panel-title">Prévia</span>
        <span className="stage-name">{sources.length === 0 ? 'vazia' : `${sources.length} ${sources.length === 1 ? 'elemento' : 'elementos'}`}</span>
        {!compact && (
          <span className="preview-actions">
            <button type="button" className="btn btn-small" disabled={!selected} onClick={props.onSendSelected} data-tip="Leva só o elemento selecionado, com a posição, o tamanho e o corte feitos aqui">
              <MonitorUp size={13} /> {selected && props.inProgramIds.has(selected.id) ? 'Atualizar selecionado no Programa' : 'Selecionado para o Programa'}
            </button>
            <button type="button" className="btn btn-small btn-primary" disabled={sources.length === 0} onClick={props.onSendAll} data-tip="Leva todos os elementos da prévia para a cena no ar">
              <MonitorUp size={13} /> Tudo para o Programa
            </button>
          </span>
        )}
        {compact && props.onExpand && <AreaExpand name="Prévia" onExpand={props.onExpand} className="area-expand-inline preview-expand" />}
      </header>
      <div className="screen screen-preview" data-testid="preview" onDoubleClick={compact ? props.onExpand : undefined}>
        {sources.length > 0 ? (
          <ProgramView
            compositor={props.compositor}
            items={items}
            sources={sources}
            pages={props.pages}
            mediaStyles={props.mediaStyles}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            onTransform={props.onTransform}
            onToggleHidden={() => undefined}
            onPageRegion={props.onPageRegion}
            live={null}
            output={props.output}
            extras={null}
            hud={NO_HUD}
            onHud={() => undefined}
            lockedIds={new Set()}
            onToggleFill={props.onToggleFill}
            onBorder={props.onBorder}
            onRemove={props.onRemove}
            editor
            viewOnly={compact}
          />
        ) : <p className="screen-empty">{compact ? 'Expanda a prévia e use o olho dos dispositivos, widgets e mídias para montar a cena aqui.' : 'Clique no olho (Pôr na prévia) de dispositivos, widgets e mídias no layout para trazê-los para cá.'}</p>}
      </div>
    </section>
  );
}

interface ProgramProps {
  sceneName: string | null;
  compositor: Compositor;
  items: SceneItem[];
  sources: Source[];
  pages: WebPage[];
  mediaStyles?: MediaStyles;
  selectedId: string | null;
  live: boolean;
  liveStatus: LiveStatus;
  output: OutputSettings;
  extras: LiveExtras | null;
  hud: ProgramHud;
  onHud: (hud: ProgramHud) => void;
  onSelect: (sourceId: string | null) => void;
  onTransform: (sourceId: string, transform: Transform | null) => void;
  onToggleHidden: (sourceId: string) => void;
  onPageRegion: (pageId: string, region: WebPage['region']) => void;
  /** Uma cena arrastada da lista foi solta aqui: vai para o ar. */
  onSceneDrop: (sceneId: string) => void;
  lockedIds: Set<string>;
  /** Replay no ar (nome) e como tirá-lo. */
  replay: { name: string; queue: number } | null;
  onStopReplay: () => void;
  /** Botão "Tela cheia"/"Voltar" na fonte selecionada. */
  onToggleFill: (sourceId: string) => void;
  onBorder: (sourceId: string, border: Border | null) => void;
  /** Abre o Programa numa janela grande (ausente = já está aberto nela). */
  onExpand?: () => void;
}

/** Programa (o que vai ao ar): fica sempre no centro, com o maior espaço da tela. */
export function ProgramPanel(props: ProgramProps) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={`stage-box stage-box-program ${over ? 'stage-box-over' : ''}`}
      aria-label="Programa"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SCENE_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SCENE_DRAG_TYPE);
        setOver(false);
        if (id) { e.preventDefault(); props.onSceneDrop(id); }
      }}
    >
      <header className="stage-head stage-head-fixed">
        <span className="panel-title">Programa</span>
        <span className="stage-name stage-program">{props.sceneName ?? 'Sem cena'}</span>
        {props.replay && (
          <span className="replay-badge" data-tip="O replay está no ar (vai para a transmissão). Depois dele o programa volta para a cena.">
            REPLAY · {props.replay.name}{props.replay.queue > 0 ? ` · +${props.replay.queue} na fila` : ''}
            <button type="button" className="link-btn" onClick={props.onStopReplay}>Voltar à cena</button>
          </span>
        )}
        {props.live && <span className="live-badge">AO VIVO</span>}
        {over && <span className="drop-hint">Solte para colocar esta cena no ar</span>}
        {props.onExpand && <AreaExpand name="Programa" onExpand={props.onExpand} className="area-expand-inline" />}
      </header>
      <div className={`screen screen-program ${props.live ? 'screen-live' : ''}`} data-testid="program">
        <ProgramView
          compositor={props.compositor}
          items={props.items}
          sources={props.sources}
          pages={props.pages}
            mediaStyles={props.mediaStyles}
          selectedId={props.selectedId}
          onSelect={props.onSelect}
          onTransform={props.onTransform}
          onToggleHidden={props.onToggleHidden}
          onPageRegion={props.onPageRegion}
          live={props.live ? props.liveStatus : null}
          output={props.output}
          extras={props.extras}
          hud={props.hud}
          onHud={props.onHud}
          lockedIds={props.lockedIds}
          onToggleFill={props.onToggleFill}
          onBorder={props.onBorder}
        />
      </div>
    </section>
  );
}
