import { useState, type DragEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Folder, FolderOpen, FolderPlus, Globe, GripVertical, LockKeyhole, LockKeyholeOpen, Mic, Pencil, Plus, Settings2, Smartphone, Trash2, Video, X } from 'lucide-react';
import { displayName } from '../devices/identify';
import type { Scene, SceneFolder, SceneItem, Source } from '../types/studio';
import { moveFolder, moveItem, removeFolder, rows, type DropTarget } from '../utils/folders';
import { newId } from '../utils/project';

export type SourceStatus = 'conectado' | 'ativo' | 'abrindo' | 'desconectado' | 'falhou';

interface Props {
  scenes: Scene[];
  activeId: string | null;
  sources: Source[];
  selectedId: string | null;
  statusOf: (source: Source) => SourceStatus;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRemoveSource: (sceneId: string, sourceId: string) => void;
  onSourceSettings: (source: Source) => void;
  onSelect: (sourceId: string) => void;
  onToggleHidden: (sourceId: string) => void;
  /** Abre/fecha o cadeado da fonte na cena ativa (fechado: não sai do lugar no Programa). */
  onToggleLock: (sourceId: string) => void;
  /** Nova ordem das camadas (da de trás para a da frente). */
  onReorder: (sceneId: string, sourceIds: string[]) => void;
  /** Muda as fontes e/ou as pastas de uma cena (ordem, pastas, ocultar tudo da pasta). */
  onSceneUpdate: (sceneId: string, patch: { items?: SceneItem[]; folders?: SceneFolder[] }) => void;
  /** Nova ordem das cenas na lista. */
  onReorderScenes: (sceneIds: string[]) => void;
  /** Miniatura de dispositivo solta numa cena: entra nela (se ainda não estiver). */
  onDropDevice: (sceneId: string, device: DeviceDrag) => void;
}

/** Arrastar uma cena: na lista muda a ordem; soltando no Programa, ela vai para o ar. */
export const SCENE_DRAG_TYPE = 'application/x-estudio-cena';

/** Arrastar a miniatura de um dispositivo: soltando numa cena (ou nas fontes da cena), ele entra nela. */
export const DEVICE_DRAG_TYPE = 'application/x-estudio-dispositivo';
export interface DeviceDrag {
  deviceId: string;
  label: string;
  kind: 'video' | 'audio';
}
export function startDeviceDrag(e: DragEvent<HTMLElement>, device: DeviceDrag): void {
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(DEVICE_DRAG_TYPE, JSON.stringify(device));
}
const isDeviceDrag = (e: DragEvent<HTMLElement>) => e.dataTransfer.types.includes(DEVICE_DRAG_TYPE);
function readDeviceDrag(e: DragEvent<HTMLElement>): DeviceDrag | null {
  try {
    const d = JSON.parse(e.dataTransfer.getData(DEVICE_DRAG_TYPE)) as Partial<DeviceDrag>;
    if (typeof d.deviceId !== 'string' || typeof d.label !== 'string' || (d.kind !== 'video' && d.kind !== 'audio')) return null;
    return { deviceId: d.deviceId, label: d.label, kind: d.kind };
  } catch {
    return null;
  }
}

const STATUS_LABEL: Record<SourceStatus, string> = { conectado: 'Conectado', ativo: 'No ar', abrindo: 'Abrindo', desconectado: 'Desconectado', falhou: 'Falhou' };

function SourceIcon({ source }: { source: Source }) {
  if (source.device.deviceId.startsWith('celular:')) return <Smartphone size={14} />;
  if (source.device.deviceId.startsWith('pagina:')) return <Globe size={14} />;
  return source.kind === 'video' ? <Video size={14} /> : <Mic size={14} />;
}

export function ScenesPanel(props: Props) {
  const { scenes, activeId, sources } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<{ kind: 'item' | 'folder'; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  const [sceneDrag, setSceneDrag] = useState<string | null>(null);
  const [sceneDrop, setSceneDrop] = useState<{ id: string; after: boolean } | null>(null);
  /** Cena sobre a qual uma miniatura de dispositivo está sendo arrastada. */
  const [deviceOver, setDeviceOver] = useState<string | null>(null);
  const deviceDropHandlers = (sceneId: string) => ({
    onDragEnter: (e: DragEvent<HTMLElement>) => { if (isDeviceDrag(e)) { e.preventDefault(); setDeviceOver(sceneId); } },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (isDeviceDrag(e) && !e.currentTarget.contains(e.relatedTarget as Node)) setDeviceOver((id) => (id === sceneId ? null : id)); },
  });
  /** Trata o arrasto de dispositivo; devolve true quando era um (os outros arrastos seguem como antes). */
  const deviceOverScene = (e: DragEvent<HTMLElement>, sceneId: string) => {
    if (!isDeviceDrag(e)) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (deviceOver !== sceneId) setDeviceOver(sceneId);
    return true;
  };
  const dropDevice = (e: DragEvent<HTMLElement>, sceneId: string) => {
    if (!isDeviceDrag(e)) return false;
    e.preventDefault();
    setDeviceOver(null);
    const device = readDeviceDrag(e);
    if (device) props.onDropDevice(sceneId, device);
    return true;
  };

  const dropScene = (targetId: string) => {
    const moved = sceneDrag;
    const after = sceneDrop?.after ?? false;
    setSceneDrag(null);
    setSceneDrop(null);
    if (!moved || moved === targetId) return;
    const order = scenes.map((s) => s.id).filter((id) => id !== moved);
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, moved);
    props.onReorderScenes(order);
  };
  const active = scenes.find((s) => s.id === activeId) ?? null;
  // Na lista, a camada da frente aparece em cima (como no programa).
  const listed = active ? [...active.items].reverse().map((item) => ({ item, source: sources.find((s) => s.id === item.sourceId) })).filter((x): x is { item: typeof x.item; source: Source } => Boolean(x.source)) : [];

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };
  /** Solta o que está sendo arrastado (fonte ou pasta) no lugar marcado. */
  const apply = () => {
    const d = drag;
    const target = dropAt;
    endDrag();
    if (!active || !d || !target) return;
    if (d.kind === 'item') props.onSceneUpdate(active.id, { items: moveItem(active, d.id, target) });
    else props.onSceneUpdate(active.id, moveFolder(active, d.id, target));
  };
  const setFolder = (id: string, patch: Partial<SceneFolder>) => {
    if (active) props.onSceneUpdate(active.id, { folders: (active.folders ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  };
  const newFolder = () => {
    if (!active) return;
    const folder: SceneFolder = { id: newId(), name: `PASTA ${(active.folders ?? []).length + 1}`, collapsed: false };
    props.onSceneUpdate(active.id, { folders: [folder, ...(active.folders ?? [])] });
    setEditingFolder(folder.id);
    setFolderName(folder.name);
  };

  const renderItem = (item: SceneItem, inFolder: boolean) => {
    const source = sources.find((x) => x.id === item.sourceId);
    if (!source || !active) return null;
    const folderLocked = Boolean(item.folder && active.folders?.find((f) => f.id === item.folder)?.locked);
    const locked = Boolean(item.locked) || folderLocked;
    const status = props.statusOf(source);
    const shared = scenes.filter((sc) => sc.items.some((i) => i.sourceId === source.id)).length;
    const marker = dropAt?.kind === 'item' && dropAt.id === source.id ? (dropAt.after ? 'drop-after' : 'drop-before') : '';
    return (
      <li
        key={source.id}
        className={`source source-${status} ${inFolder ? 'source-in-folder' : ''} ${props.selectedId === source.id ? 'source-selected' : ''} ${drag?.kind === 'item' && drag.id === source.id ? 'source-dragging' : ''} ${marker} ${item.hidden ? 'source-hidden' : ''}`}
        data-testid="scene-source"
        draggable
        onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'item', id: source.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', source.id); }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (!drag) return;
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          if (dropAt?.kind !== 'item' || dropAt.id !== source.id || dropAt.after !== after) setDropAt({ kind: 'item', id: source.id, after });
        }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); apply(); }}
        onClick={() => props.onSelect(source.id)}
      >
        <GripVertical size={13} className="grip" />
        <SourceIcon source={source} />
        <span className="source-name" title={source.device.label}>
          {displayName(source.name)}
          {shared > 1 && <small title="A mesma captura é usada nas outras cenas, sem abrir o dispositivo de novo"> · em {shared} cenas</small>}
        </span>
        <span className={`status-tag status-${status}`}><i />{STATUS_LABEL[status]}</span>
        {status === 'desconectado' && !source.device.deviceId.includes(':') && <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); props.onSourceSettings(source); }}>Trocar</button>}
        {source.kind === 'video' && (
          <button
            type="button"
            className={`icon-btn lock-btn ${locked ? 'lock-on' : ''}`}
            aria-pressed={locked}
            disabled={folderLocked}
            aria-label={locked ? `Destravar ${source.name}` : `Travar ${source.name} no lugar`}
            data-tip={folderLocked ? 'Travado pelo cadeado da pasta' : locked ? 'Travado: não dá para mover, redimensionar nem cortar no Programa. Clique para destravar' : 'Clique para travar no lugar em que está no Programa'}
            onClick={(e) => { e.stopPropagation(); props.onToggleLock(source.id); }}
          >
            {locked ? <LockKeyhole size={14} strokeWidth={2.4} /> : <LockKeyholeOpen size={14} />}
          </button>
        )}
        {source.kind === 'video' && (
          <button type="button" className="icon-btn" aria-label={item.hidden ? `Mostrar ${source.name}` : `Ocultar ${source.name}`} title={item.hidden ? 'Mostrar no programa' : 'Ocultar do programa'} onClick={(e) => { e.stopPropagation(); props.onToggleHidden(source.id); }}>
            {item.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={`Configurar ${source.name}`} title="Configurações" onClick={(e) => { e.stopPropagation(); props.onSourceSettings(source); }}><Settings2 size={13} /></button>
        <button type="button" className="icon-btn" aria-label={`Tirar ${source.name} da cena`} title="Tirar da cena" onClick={(e) => { e.stopPropagation(); props.onRemoveSource(active.id, source.id); }}><X size={13} /></button>
      </li>
    );
  };

  return (
    <section className="panel" aria-label="Cenas">
      <header className="panel-head">
        <h2 className="panel-title">Cenas</h2>
        <button type="button" className="icon-btn" onClick={props.onAdd} aria-label="Nova cena" title="Nova cena"><Plus size={15} /></button>
      </header>
      <ul className="scene-list">
        {scenes.map((scene) => (
          <li
            key={scene.id}
            className={`scene ${scene.id === activeId ? 'scene-active' : ''} ${deviceOver === scene.id ? 'scene-device-over' : ''} ${sceneDrag === scene.id ? 'source-dragging' : ''} ${sceneDrop?.id === scene.id ? (sceneDrop.after ? 'drop-after' : 'drop-before') : ''}`}
            draggable={editing !== scene.id}
            onDragStart={(e) => {
              setSceneDrag(scene.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(SCENE_DRAG_TYPE, scene.id);
            }}
            onDragEnd={() => { setSceneDrag(null); setSceneDrop(null); }}
            {...deviceDropHandlers(scene.id)}
            onDragOver={(e) => {
              if (deviceOverScene(e, scene.id)) return;
              if (!sceneDrag) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setSceneDrop({ id: scene.id, after: e.clientY > r.top + r.height / 2 });
            }}
            onDrop={(e) => { if (dropDevice(e, scene.id)) return; e.preventDefault(); dropScene(scene.id); }}
          >
            {editing !== scene.id && <GripVertical size={13} className="grip scene-grip" />}
            {editing === scene.id ? (
              <form className="scene-edit" onSubmit={(e) => { e.preventDefault(); if (name.trim()) props.onRename(scene.id, name.trim()); setEditing(null); }}>
                <input className="field" value={name} autoFocus onChange={(e) => setName(e.target.value)} aria-label="Nome da cena" />
                <button type="submit" className="icon-btn" aria-label="Salvar nome"><Check size={14} /></button>
                <button type="button" className="icon-btn" aria-label="Cancelar" onClick={() => setEditing(null)}><X size={14} /></button>
              </form>
            ) : (
              <>
                <button type="button" className="scene-button" onClick={() => props.onActivate(scene.id)}>
                  <span>{scene.name}</span>
                  <small>{scene.items.length} {scene.items.length === 1 ? 'fonte' : 'fontes'}</small>
                </button>
                <button type="button" className="icon-btn" aria-label={`Renomear ${scene.name}`} title="Renomear" onClick={() => { setEditing(scene.id); setName(scene.name); }}><Pencil size={13} /></button>
                <button type="button" className="icon-btn" aria-label={`Excluir ${scene.name}`} title="Excluir cena" disabled={scenes.length <= 1} onClick={() => props.onDelete(scene.id)}><Trash2 size={13} /></button>
              </>
            )}
          </li>
        ))}
      </ul>
      {active && (
        <div
          className={`scene-sources ${deviceOver === active.id ? 'scene-sources-device-over' : ''}`}
          {...deviceDropHandlers(active.id)}
          onDragOver={(e) => { deviceOverScene(e, active.id); }}
          onDrop={(e) => { dropDevice(e, active.id); }}
        >
          <div className="sources-head">
            <h3 className="group-title">Fontes do programa · {active.name}</h3>
            <button type="button" className="icon-btn" aria-label="Nova pasta" data-tip="Nova pasta: arraste fontes para dentro para organizar" onClick={newFolder}><FolderPlus size={15} /></button>
          </div>
          {listed.length === 0 && (active.folders ?? []).length === 0 && (
            <p className="empty-text">Arraste a miniatura de um dispositivo para cá (ou para o nome de uma cena), ou use “Adicionar à cena”.</p>
          )}
          <ul className="source-list">
            {rows(active).map((row) => {
              if (row.kind === 'item') return renderItem(row.item, false);
              const { folder, items } = row;
              const videos = items.filter((i) => sources.find((x) => x.id === i.sourceId)?.kind === 'video');
              const allHidden = videos.length > 0 && videos.every((i) => i.hidden);
              const marker = dropAt?.kind === 'folder' && dropAt.id === folder.id ? `folder-drop-${dropAt.zone}` : '';
              return (
                <li key={`pasta:${folder.id}`} className={`source-folder ${drag?.kind === 'folder' && drag.id === folder.id ? 'source-dragging' : ''}`}>
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
                      const zone = drag.kind === 'item' ? (y < 0.25 ? 'before' : y > 0.75 && folder.collapsed ? 'after' : 'inside') : y < 0.5 ? 'before' : 'after';
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
                        {folder.name} <small>· {items.length} {items.length === 1 ? 'fonte' : 'fontes'}</small>
                      </span>
                    )}
                    <button
                      type="button"
                      className={`icon-btn lock-btn ${folder.locked ? 'lock-on' : ''}`}
                      aria-pressed={Boolean(folder.locked)}
                      aria-label={folder.locked ? `Destravar a pasta ${folder.name}` : `Travar tudo da pasta ${folder.name}`}
                      data-tip={folder.locked ? 'Pasta travada: nenhuma fonte dela sai do lugar no Programa. Clique para destravar' : 'Travar todas as fontes da pasta no lugar'}
                      onClick={() => setFolder(folder.id, { locked: !folder.locked })}
                    >
                      {folder.locked ? <LockKeyhole size={14} strokeWidth={2.4} /> : <LockKeyholeOpen size={14} />}
                    </button>
                    {videos.length > 0 && (
                      <button type="button" className="icon-btn" aria-label={allHidden ? `Mostrar tudo da pasta ${folder.name}` : `Ocultar tudo da pasta ${folder.name}`} data-tip={allHidden ? 'Mostrar tudo da pasta no programa' : 'Ocultar tudo da pasta do programa'} onClick={() => props.onSceneUpdate(active.id, { items: active.items.map((i) => (videos.some((v) => v.sourceId === i.sourceId) ? { ...i, hidden: !allHidden } : i)) })}>
                        {allHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    )}
                    <button type="button" className="icon-btn" aria-label={`Renomear a pasta ${folder.name}`} data-tip="Renomear pasta" onClick={() => { setEditingFolder(folder.id); setFolderName(folder.name); }}><Pencil size={13} /></button>
                    <button type="button" className="icon-btn icon-btn-remove" aria-label={`Apagar a pasta ${folder.name}`} data-tip="Apagar a pasta (as fontes continuam na cena)" onClick={() => props.onSceneUpdate(active.id, removeFolder(active, folder.id))}><Trash2 size={13} /></button>
                  </div>
                  {!folder.collapsed && (
                    <ul className="source-list folder-children">
                      {items.length === 0 ? <li className="folder-empty">Arraste fontes para cá</li> : items.map((item) => renderItem(item, true))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
