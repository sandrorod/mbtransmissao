import { useState, useSyncExternalStore } from 'react';
import { Eye, EyeOff, Image as ImageIcon, Pause, Play, Plus, Repeat, RotateCcw, Square, Trash2, Upload, Video, Volume2, VolumeX } from 'lucide-react';
import { mediaPlayers } from '../devices/mediaPlayers';
import { pool } from '../devices/pool';
import type { MediaItem } from '../types/studio';
import { StatusTag } from './common';
import { SelectAll, SelectionBar, type GroupActions } from './SelectionBar';

interface Props {
  media: MediaItem[];
  previewIds: Set<string>;
  /** Mídias que estão na cena no ar agora. */
  inProgram: Set<string>;
  onImport: () => void;
  onPreview: (item: MediaItem) => void;
  onAdd: (item: MediaItem) => void;
  /** Tira a mídia da cena no ar (o mesmo quadrado vermelho dos dispositivos). */
  onStop: (item: MediaItem) => void;
  onChange: (item: MediaItem) => void;
  onRemove: (item: MediaItem) => void;
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  group: GroupActions;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Área Mídias: fotos e vídeos do computador para exibir na transmissão. */
export function MediaPanel({ media, previewIds, inProgram, onImport, onPreview, onAdd, onStop, onChange, onRemove, selected, onSelect, group }: Props) {
  useSyncExternalStore(mediaPlayers.subscribe, mediaPlayers.getVersion);
  useSyncExternalStore(pool.subscribe, pool.getVersion);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="panel media-panel" aria-label="Mídias">
      <header className="panel-head">
        <h2 className="panel-title">Mídias</h2>
        <span className="panel-head-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={onImport} data-tip="Foto (JPG, PNG, GIF, WebP) ou vídeo (MP4, MOV, WebM)"><Upload size={13} /> Carregar foto ou vídeo</button>
        </span>
      </header>
      {media.length > 0 && (
        <div className="media-select-row">
          <SelectAll ids={media.map((m) => `midia:${m.id}`)} selected={selected} onSelect={onSelect} label="Selecionar todas as mídias" />
        </div>
      )}
      <SelectionBar actions={group} />
      {media.length === 0 ? (
        <p className="empty-text">Carregue uma foto ou um vídeo para exibir na transmissão (logo, patrocinador, vinheta, intervalo…).</p>
      ) : (
        <ul className="device-list">
          {media.map((item) => {
            const deviceId = `midia:${item.id}`;
            const entries = pool.list().filter((e) => e.spec.deviceId === deviceId);
            const status = entries.some((e) => e.status === 'ativo') ? 'ativo' : entries.some((e) => e.status === 'falhou') ? 'falhou' : entries.some((e) => e.status === 'abrindo') ? 'abrindo' : 'conectado';
            const state = mediaPlayers.state(item.id);
            const previewing = previewIds.has(deviceId);
            const expanded = open === item.id;
            const video = item.kind === 'video';
            return (
              <li key={item.id} className={`device-card ${expanded ? 'device-card-open' : ''} ${previewing ? 'device-card-on' : ''}`}>
                <div className="media-head-row">
                  <input type="checkbox" className="media-check" checked={selected.has(deviceId)} aria-label={`Selecionar ${item.name}`} onChange={(e) => onSelect([deviceId], e.target.checked)} />
                  <button type="button" className="device-head" onClick={() => setOpen(expanded ? null : item.id)} title={`${item.name}.${item.ext}`}>
                    <span className="device-icon">{video ? <Video size={15} /> : <ImageIcon size={15} />}</span>
                    <strong className="device-title">{item.name}</strong>
                    {inProgram.has(item.id) && <span className="media-onair" title="Está na cena no ar">no ar</span>}
                    {/* O status só aparece quando há problema (o espaço fica para o nome). */}
                    {status === 'falhou' && <StatusTag status={status} />}
                  </button>
                  <span className="media-actions">
                  <button type="button" className={`icon-btn row-eye ${previewing ? 'icon-btn-on' : ''}`} aria-label={previewing ? `Tirar ${item.name} da prévia` : `Pôr ${item.name} na prévia`} data-tip={previewing ? 'Tirar da prévia' : 'Pôr na prévia'} onClick={() => onPreview(item)}>
                    {previewing ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {inProgram.has(item.id) ? (
                    <button type="button" className="icon-btn row-eye tile-btn-stop" aria-label={`Tirar ${item.name} do Programa`} data-tip="Está no Programa: clique para tirar da cena no ar" onClick={() => onStop(item)}><Square size={13} /></button>
                  ) : (
                    <button type="button" className="icon-btn row-eye" aria-label={`Colocar ${item.name} no Programa`} data-tip="Colocar no Programa (por cima de tudo)" onClick={() => onAdd(item)}><Play size={14} /></button>
                  )}
                  <button type="button" className="icon-btn row-eye icon-btn-remove" aria-label={`Apagar ${item.name}`} data-tip="Apagar mídia (sai da lista, das cenas e do programa)" onClick={() => onRemove(item)}><Trash2 size={14} /></button>
                  </span>
                </div>
                {video && state && (
                  <div className="media-transport">
                    <button type="button" className="icon-btn" aria-label={state.playing ? 'Pausar' : 'Tocar'} data-tip={state.playing ? 'Pausar' : 'Tocar'} onClick={() => mediaPlayers.control(item.id, state.playing ? 'pause' : 'play')}>{state.playing ? <Pause size={14} /> : <Play size={14} />}</button>
                    <button type="button" className="icon-btn" aria-label="Voltar ao começo" data-tip="Voltar ao começo e tocar" onClick={() => mediaPlayers.control(item.id, 'restart')}><RotateCcw size={14} /></button>
                    <input type="range" min={0} max={Math.max(0.1, state.duration)} step={0.1} value={Math.min(state.time, state.duration)} aria-label="Posição do vídeo" onChange={(e) => mediaPlayers.control(item.id, Number(e.target.value))} />
                    <span className="media-time">{clock(state.time)} / {clock(state.duration)}</span>
                  </div>
                )}
                {expanded && (
                  <div className="device-body">
                    <dl className="device-specs">
                      <dt>Tipo</dt><dd>{video ? 'Vídeo' : item.ext === 'gif' ? 'GIF animado' : 'Foto'} ({item.ext.toUpperCase()})</dd>
                      {video && <><dt>Ao terminar</dt><dd>{item.loop ? 'Recomeça' : 'Para no último quadro'}</dd></>}
                      {video && <><dt>Som</dt><dd>{item.audio ? 'Vai para o mixer' : 'Sem som'}</dd></>}
                    </dl>
                    {state?.error && <p className="device-error">{state.error}</p>}
                    <div className="device-actions">
                      <button type="button" className={`btn btn-small ${previewing ? 'btn-on' : ''}`} onClick={() => onPreview(item)}>
                        {previewing ? <EyeOff size={13} /> : <Eye size={13} />} {previewing ? 'Tirar da prévia' : 'Pôr na prévia'}
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => onAdd(item)}><Plus size={13} /> Adicionar à cena</button>
                      <span className="device-actions-right">
                        {video && <button type="button" className={`icon-btn ${item.loop ? 'icon-btn-on' : ''}`} aria-pressed={item.loop} aria-label="Repetir" data-tip={item.loop ? 'Repetindo: clique para parar no fim' : 'Clique para repetir sem parar'} onClick={() => onChange({ ...item, loop: !item.loop })}><Repeat size={14} /></button>}
                        {video && <button type="button" className={`icon-btn ${item.audio ? 'icon-btn-on' : ''}`} aria-pressed={item.audio} aria-label="Som do vídeo" data-tip={item.audio ? 'Com som (no mixer)' : 'Sem som'} onClick={() => onChange({ ...item, audio: !item.audio })}>{item.audio ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>}
                        <button type="button" className="icon-btn icon-btn-remove" aria-label={`Remover ${item.name}`} data-tip="Remover" onClick={() => onRemove(item)}><Trash2 size={14} /></button>
                      </span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
