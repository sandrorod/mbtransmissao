import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ChevronDown, ChevronRight, Clapperboard, CloudUpload, Gauge, Globe, Film, Pipette, Folder, FolderOpen, FolderPlus, FolderSearch, Pencil, Play, Scissors, Square, Trash2, Upload, X } from 'lucide-react';
import { DEFAULT_CHROMA, REPLAY_MAX, REPLAY_MIN, REPLAY_SPEEDS, TRANSITIONS, type ChromaKey, type ReplayClip, type ReplayFolder, type ReplayIntro, type ReplayTransition, type TransitionKind, type VignetteKind } from '../types/studio';
import type { ReplayPlayer } from '../program/replay';
import { INTRO_ID, OUTRO_ID, useReplay } from '../program/replay';
import { Modal } from './common';
import { ConfirmDialog, ReplayGalleryDialog } from './Dialogs';
import { MIN_CUT, VignetteEditor } from './VignetteEditor';
import { clipName } from '../utils/replayNames';

const isMac = navigator.platform.toLowerCase().includes('mac');
export const REPLAY_SHORTCUT = isMac ? '⌘R ou Ctrl+R' : 'Ctrl+R';
/** Quanto tempo segurar o tempo do replay para abrir a troca. */
const HOLD_MS = 450;
const DRAG_CLIP = 'application/x-estudio-replay';

const hour = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? '' : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} · `;
};
const secs = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
const newId = () => Math.random().toString(36).slice(2, 10);

/** Duração que vai ao ar (com o corte de início/fim). */
export const clipLength = (c: ReplayClip) => Math.max(0, (c.end ?? c.seconds) - (c.start ?? 0));
const trimmed = (c: ReplayClip) => (c.start ?? 0) > 0 || c.end != null;

/**
 * Nome do replay: o dado pelo operador ou "Replay N" (N = ordem do corte). Um corte gera um vídeo do Programa e
 * um de cada câmera: todos têm o mesmo N, com o nome da câmera junto.
 */
export function replayLabel(clips: ReplayClip[], id: string): string {
  return id === INTRO_ID ? 'Vinheta de entrada' : id === OUTRO_ID ? 'Vinheta de saída' : clipName(clips, id);
}

/** Tempo do replay: clique mostra a dica; segurar abre a troca ali mesmo. */
function ReplayTime({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const [open, setOpen] = useState(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  useEffect(() => cancel, []);
  return (
    <span className="replay-time" ref={box}>
      <button
        type="button"
        className={`replay-chip ${open ? 'replay-chip-open' : ''}`}
        data-tip={open ? undefined : `Replay de ${seconds} s (${isMac ? '⌘R' : 'Ctrl+R'} durante a transmissão). Segure para alterar o tempo.`}
        aria-label={`Tempo do replay: ${seconds} segundos. Segure para alterar.`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          cancel();
          hold.current = setTimeout(() => { hold.current = null; setOpen(true); }, HOLD_MS);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Clapperboard size={12} /> {seconds} s · {isMac ? '⌘R' : 'Ctrl+R'}
      </button>
      {open && (
        <span className="replay-time-pop" role="dialog" aria-label="Tempo do replay">
          <span className="replay-time-head">
            <strong>Tempo do replay</strong>
            <output>{seconds} s</output>
          </span>
          <input type="range" min={REPLAY_MIN} max={REPLAY_MAX} step={1} value={seconds} autoFocus aria-label="Segundos do replay" onChange={(e) => onChange(Number(e.target.value))} />
          <span className="replay-time-presets">
            {[10, 15, 20, 30].map((s) => (
              <button key={s} type="button" className={`btn btn-small ${s === seconds ? 'btn-on' : ''}`} onClick={() => onChange(s)}>{s} s</button>
            ))}
          </span>
          <small>Vale para os próximos cortes ({REPLAY_MIN} a {REPLAY_MAX} s).</small>
        </span>
      )}
    </span>
  );
}

const speedLabel = (v: number) => `${String(v).replace('.', ',')}x`;

/** Velocidade dos replays (câmera lenta). Só os vídeos de replay; as vinhetas passam sempre em 1x. */
function ReplaySpeed({ speed, onChange }: { speed: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="replay-time" ref={box}>
      <button
        type="button"
        className={`replay-chip ${open ? 'replay-chip-open' : ''}`}
        data-tip={open ? undefined : `Velocidade dos replays: ${speedLabel(speed)}${speed < 1 ? ' (câmera lenta)' : ''}. As vinhetas passam sempre na velocidade normal.`}
        aria-label={`Velocidade dos replays: ${speedLabel(speed)}. Clique para alterar.`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge size={12} /> {speedLabel(speed)}
      </button>
      {open && (
        <span className="replay-time-pop" role="dialog" aria-label="Velocidade dos replays">
          <span className="replay-time-head">
            <strong>Velocidade dos replays</strong>
            <output>{speedLabel(speed)}</output>
          </span>
          <span className="replay-time-presets">
            {REPLAY_SPEEDS.map((v) => (
              <button key={v} type="button" className={`btn btn-small ${v === speed ? 'btn-on' : ''}`} onClick={() => { onChange(v); setOpen(false); }}>{speedLabel(v)}</button>
            ))}
          </span>
          <small>Vale na hora, inclusive no replay que está no ar. As vinhetas de entrada e saída não mudam.</small>
        </span>
      )}
    </span>
  );
}

/**
 * Replays cortados durante a transmissão (⌘R / Ctrl+R), organizados em pastas. Clicar põe no ar na hora; com vários
 * marcados, "Exibir" passa todos, do mais recente para o mais antigo (com a abertura e as transições).
 */
export function ReplayPanel({ player, seconds, onSeconds, speed, onSpeed }: { player: ReplayPlayer; seconds: number; onSeconds: (s: number) => void; speed: number; onSpeed: (v: number) => void }) {
  const { clips, folders, playing, queue } = useReplay(player);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const marked = clips.filter((c) => chosen.has(c.id));
  const [gallery, setGallery] = useState(false);
  /** Envio ao Google Drive: andamento e resultado (fica embaixo dos botões). */
  const [upload, setUpload] = useState<{ done: number; total: number; name: string; result?: string; error?: boolean; links?: string[] } | null>(null);
  useEffect(() => window.studio.onDriveProgress((p) => setUpload((u) => ({ ...(u ?? {}), ...p, result: undefined, error: false }))), []);
  // Envio automático (depois de cada corte): mostra o resultado e some sozinho quando deu certo.
  useEffect(() => window.studio.onDriveAutoDone((r) => {
    setUpload({ done: r.total, total: r.total, name: '', error: Boolean(r.error), result: r.error ? `Envio ao Drive falhou: ${r.error}` : `${r.sent} ${r.sent === 1 ? 'replay enviado' : 'replays enviados'} ao Drive (${r.project}).` });
    if (!r.error) setTimeout(() => setUpload((u) => (u?.result && !u.error ? null : u)), 6000);
  }), []);
  const sendToDrive = async () => {
    const items = marked.map((c) => ({ id: c.id, name: replayLabel(clips, c.id), folder: folders.find((f) => f.id === folderOf(c))?.name ?? null }));
    setUpload({ done: 0, total: items.length, name: '' });
    try {
      const results = await window.studio.driveUpload(items);
      const failed = results.filter((r) => !r.ok);
      setUpload({
        done: results.length,
        total: results.length,
        name: '',
        error: failed.length > 0,
        result: failed.length === 0
          ? `${results.length} ${results.length === 1 ? 'replay enviado' : 'replays enviados'} ao Google Drive.`
          : `${results.length - failed.length} de ${results.length} enviados. Falhou: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`,
      });
    } catch (e) {
      setUpload({ done: 0, total: 0, name: '', error: true, result: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    }
  };
  const allMarked = clips.length > 0 && marked.length === clips.length;
  const setMany = (ids: string[], on: boolean) => setChosen((s) => {
    const next = new Set(s);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  });
  const folderOf = (c: ReplayClip) => (c.folder && folders.some((f) => f.id === c.folder) ? c.folder : null);
  const loose = clips.filter((c) => !folderOf(c));
  const editingClip = clips.find((c) => c.id === editing) ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  // O replay que entra no ar fica à vista na lista (rola até ele).
  useEffect(() => {
    if (!playing) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-clip="${CSS.escape(playing)}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [playing]);

  const newFolder = () => {
    const folder = { id: newId(), name: `Pasta ${folders.length + 1}`, collapsed: false };
    void player.saveFolders([...folders, folder]);
    setRenaming({ id: folder.id, name: folder.name });
  };
  const setFolder = (id: string, patch: Partial<ReplayFolder>) => void player.saveFolders(folders.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  /** Leva para a pasta (null = fora de pasta) só os que ainda não estão nela. */
  const moveTo = (ids: string[], folder: string | null) => {
    const moving = clips.filter((c) => ids.includes(c.id) && folderOf(c) !== folder).map((c) => c.id);
    void player.updateMany(moving, { folder });
  };
  const dropZone = (key: string, folder: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_CLIP)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dropOn !== key) setDropOn(key);
    },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOn(null); },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropOn(null);
      const ids = e.dataTransfer.getData(DRAG_CLIP).split('\n').filter(Boolean);
      if (ids.length) moveTo(ids, folder);
    },
  });

  const renderClip = (clip: ReplayClip) => {
    const name = replayLabel(clips, clip.id);
    const onAir = playing === clip.id;
    const waiting = queue.indexOf(clip.id);
    return (
      <li
        key={clip.id}
        className={`replay-item ${onAir ? 'replay-on-air' : ''} ${chosen.has(clip.id) ? 'replay-marked' : ''}`}
        data-clip={clip.id}
        aria-current={onAir ? 'true' : undefined}
        draggable
        onDragStart={(e) => {
          // Arrastou um dos marcados: vão todos os marcados juntos; senão, só este.
          const ids = chosen.has(clip.id) ? clips.filter((c) => chosen.has(c.id)).map((c) => c.id) : [clip.id];
          e.dataTransfer.setData(DRAG_CLIP, ids.join('\n'));
          e.dataTransfer.effectAllowed = 'move';
          if (ids.length > 1) {
            // Etiqueta com a quantidade no lugar da imagem do item.
            const tag = document.createElement('div');
            tag.className = 'replay-drag-count';
            tag.textContent = `${ids.length} replays`;
            document.body.appendChild(tag);
            e.dataTransfer.setDragImage(tag, 10, 10);
            setTimeout(() => tag.remove(), 0);
          }
        }}
        onDragEnd={() => setDropOn(null)}
      >
        <input type="checkbox" checked={chosen.has(clip.id)} onChange={(e) => setMany([clip.id], e.target.checked)} aria-label={`Marcar ${name}`} />
        <button type="button" className="replay-play" onClick={() => player.play([clip.id])} data-tip={clip.note ? `${clip.note} · clique para exibir agora` : 'Clique para exibir agora no Programa'}>
          <Play size={13} className="replay-play-icon" />
          <span className="replay-name" title={name}>{name}</span>
          <small>{day(clip.createdAt)}{hour(clip.createdAt)} · {secs(clipLength(clip))}{trimmed(clip) ? ' ✂' : ''}</small>
          {onAir && <span className="replay-tag"><i className="replay-live-dot" /> NO AR</span>}
          {waiting >= 0 && <span className="replay-tag replay-tag-next">{waiting + 1}º na fila</span>}
        </button>
        <button type="button" className="icon-btn" aria-label={`Editar ${name}`} data-tip="Editar nome, pasta, observação e corte" onClick={() => setEditing(clip.id)}><Pencil size={13} /></button>
        <button type="button" className="icon-btn" aria-label={`Mostrar o arquivo de ${name}`} data-tip="Mostrar o arquivo no Finder" onClick={() => void window.studio.replayReveal(clip.id)}><FolderSearch size={13} /></button>
        <button type="button" className="icon-btn icon-btn-remove" aria-label={`Apagar ${name}`} data-tip="Apagar este replay" onClick={() => { setMany([clip.id], false); void player.remove(clip.id); }}><Trash2 size={13} /></button>
      </li>
    );
  };

  return (
    <section className="panel replay-panel" aria-label="Replay">
      <header className="panel-head">
        <h2 className="panel-title">Replay</h2>
        <span className="panel-head-actions">
          {playing ? (
            <button type="button" className="btn btn-small btn-danger" onClick={() => player.stop()} data-tip="Tirar o replay do ar e voltar para a cena">
              <Square size={12} /> Parar{queue.length > 0 ? ` (+${queue.length})` : ''}
            </button>
          ) : (
            <ReplayTime seconds={seconds} onChange={onSeconds} />
          )}
          <ReplaySpeed speed={speed} onChange={onSpeed} />
          <button type="button" className="icon-btn" aria-label="Página dos replays" data-tip="Página dos replays: link e QR Code para ver e baixar no celular ou outro computador (mesmo Wi‑Fi)" onClick={() => setGallery(true)}><Globe size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Nova pasta de replays" data-tip="Nova pasta: arraste replays para dentro" onClick={newFolder}><FolderPlus size={15} /></button>
        </span>
      </header>
      {gallery && <ReplayGalleryDialog onClose={() => setGallery(false)} />}
      {clips.length === 0 && folders.length === 0 && <p className="empty-text">Durante a transmissão, {REPLAY_SHORTCUT} corta os últimos {seconds} s e o replay aparece aqui.</p>}
      {clips.length > 0 && (
        <div className="replay-actions">
          <button type="button" className="btn btn-small btn-primary" disabled={marked.length === 0} onClick={() => player.play(marked.map((c) => c.id))} data-tip="Passa os marcados no Programa (abertura, depois do mais recente para o mais antigo)">
            <Play size={12} /> Exibir {marked.length > 0 ? `${marked.length} marcado${marked.length > 1 ? 's' : ''}` : 'marcados'}
          </button>
          {/* Excluir fica à esquerda: "Marcar todos" não muda de lugar quando ele aparece. */}
          {marked.length > 0 && (
            <button type="button" className="btn btn-small btn-danger-outline" onClick={() => setConfirmDelete(true)} data-tip="Apaga os replays marcados (os arquivos também)">
              <Trash2 size={12} /> {allMarked ? 'Excluir todos' : `Excluir ${marked.length}`}
            </button>
          )}
          {marked.length > 0 && (
            <button type="button" className="btn btn-small" disabled={upload !== null && upload.total > 0 && upload.done < upload.total} onClick={() => void sendToDrive()} data-tip="Envia os replays marcados para a pasta do Estúdio no Google Drive (Configurações › Google Drive)">
              <CloudUpload size={12} /> Enviar {marked.length} ao Drive
            </button>
          )}
          <label className="replay-all">
            <input type="checkbox" checked={allMarked} ref={(el) => { if (el) el.indeterminate = marked.length > 0 && !allMarked; }} onChange={() => setChosen(allMarked ? new Set() : new Set(clips.map((c) => c.id)))} aria-label={allMarked ? 'Desmarcar todos os replays' : 'Marcar todos os replays'} />
            {allMarked ? 'Desmarcar todos' : 'Marcar todos'}
          </label>
        </div>
      )}
      {upload && (
        <p className={`replay-upload ${upload.error ? 'device-error' : 'hint'}`} role="status">
          {upload.result ?? `Enviando ao Google Drive: ${Math.min(upload.done + 1, upload.total)} de ${upload.total}${upload.name ? ` · ${upload.name}` : ''}…`}
          {upload.result && <button type="button" className="link-btn" onClick={() => setUpload(null)}>OK</button>}
        </p>
      )}
      {playing && (
        <div className="replay-now" role="status">
          <i className="replay-live-dot" /> No ar: <strong>{replayLabel(clips, playing)}</strong>
          {queue.length > 0 && <small>· depois: {queue.length} na fila</small>}
        </div>
      )}
      <ul className="replay-list" ref={list}>
        {folders.map((folder) => {
          const inside = clips.filter((c) => folderOf(c) === folder.id);
          const all = inside.length > 0 && inside.every((c) => chosen.has(c.id));
          const some = inside.some((c) => chosen.has(c.id));
          return (
            <li key={`pasta:${folder.id}`} className="replay-folder">
              <div className={`replay-folder-head ${dropOn === folder.id ? 'replay-drop' : ''}`} {...dropZone(folder.id, folder.id)}>
                <button type="button" className="icon-btn folder-toggle" aria-expanded={!folder.collapsed} aria-label={folder.collapsed ? `Abrir a pasta ${folder.name}` : `Fechar a pasta ${folder.name}`} onClick={() => setFolder(folder.id, { collapsed: !folder.collapsed })}>
                  {folder.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <input type="checkbox" checked={all} disabled={inside.length === 0} ref={(el) => { if (el) el.indeterminate = some && !all; }} onChange={() => setMany(inside.map((c) => c.id), !all)} aria-label={`Marcar os replays da pasta ${folder.name}`} />
                {folder.collapsed ? <Folder size={14} className="folder-icon" /> : <FolderOpen size={14} className="folder-icon" />}
                {renaming?.id === folder.id ? (
                  <form className="scene-edit" onSubmit={(e) => { e.preventDefault(); if (renaming.name.trim()) setFolder(folder.id, { name: renaming.name.trim().slice(0, 80) }); setRenaming(null); }}>
                    <input className="field" value={renaming.name} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setRenaming({ id: folder.id, name: e.target.value })} aria-label="Nome da pasta" onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
                  </form>
                ) : (
                  <span className="replay-folder-name" onDoubleClick={() => setRenaming({ id: folder.id, name: folder.name })}>
                    {folder.name} <small>· {inside.length}</small>
                  </span>
                )}
                <button type="button" className="icon-btn" disabled={inside.length === 0} aria-label={`Exibir a pasta ${folder.name}`} data-tip="Exibir todos os replays da pasta" onClick={() => player.play(inside.map((c) => c.id))}><Play size={13} /></button>
                <button type="button" className="icon-btn" aria-label={`Renomear a pasta ${folder.name}`} data-tip="Renomear pasta" onClick={() => setRenaming({ id: folder.id, name: folder.name })}><Pencil size={13} /></button>
                <button type="button" className="icon-btn icon-btn-remove" aria-label={`Apagar a pasta ${folder.name}`} data-tip="Apagar a pasta (os replays continuam na lista)" onClick={() => void player.saveFolders(folders.filter((f) => f.id !== folder.id))}><Trash2 size={13} /></button>
              </div>
              {/* Pasta fechada abre na tela enquanto um replay dela está no ar. */}
              {(!folder.collapsed || inside.some((c) => c.id === playing)) && (
                <ul className="replay-list replay-folder-children">
                  {inside.length === 0 ? <li className="folder-empty">Arraste replays para cá</li> : inside.map(renderClip)}
                </ul>
              )}
            </li>
          );
        })}
        {folders.length > 0 && clips.length > 0 && (
          <li className={`replay-loose-head ${dropOn === '' ? 'replay-drop' : ''}`} {...dropZone('', null)}>Fora de pasta</li>
        )}
        {loose.map(renderClip)}
      </ul>
      {confirmDelete && (
        <ConfirmDialog
          title={allMarked ? 'Excluir todos os replays' : `Excluir ${marked.length} replay${marked.length > 1 ? 's' : ''}`}
          message={`${allMarked ? `Todos os ${marked.length} replays` : marked.length > 1 ? `Os ${marked.length} replays marcados` : 'O replay marcado'} e os arquivos de vídeo serão apagados. Não dá para desfazer.${marked.some((c) => c.id === playing || queue.includes(c.id)) ? ' A exibição no Programa para e volta para a cena.' : ''}`}
          confirm={allMarked ? 'Excluir todos' : 'Excluir'}
          onConfirm={() => {
            const ids = marked.map((c) => c.id);
            setChosen(new Set());
            void player.removeMany(ids);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {editingClip && <ReplayEditDialog player={player} clip={editingClip} label={replayLabel(clips, editingClip.id)} folders={folders} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** Editar o replay: nome, pasta, observação e o corte (onde começa e onde termina). */
function ReplayEditDialog({ player, clip, label, folders, onClose }: { player: ReplayPlayer; clip: ReplayClip; label: string; folders: ReplayFolder[]; onClose: () => void }) {
  const [name, setName] = useState(clip.name ?? '');
  const [note, setNote] = useState(clip.note ?? '');
  const [folder, setFolder] = useState<string>(clip.folder ?? '');
  const [start, setStart] = useState(clip.start ?? 0);
  const [end, setEnd] = useState<number | null>(clip.end ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(clip.seconds);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { void player.url(clip.id).then(setUrl, () => setUrl(null)); }, [player, clip.id]);
  const stop = end ?? duration;
  const valid = stop - start >= 1;
  const now = () => Math.round((video.current?.currentTime ?? 0) * 10) / 10;

  const save = () => {
    void player.update(clip.id, { name: name.trim(), note: note.trim(), folder: folder || null, start, end: end !== null && end < duration - 0.05 ? end : null });
    onClose();
  };

  return (
    <Modal title={`Editar ${label}`} onClose={onClose}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); if (valid) save(); }}>
        {url ? (
          <video
            ref={video}
            className="replay-edit-video"
            src={url}
            controls
            muted
            onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); e.currentTarget.currentTime = start; }}
            onTimeUpdate={(e) => { if (end !== null && e.currentTarget.currentTime > end) e.currentTarget.pause(); }}
          />
        ) : <div className="replay-edit-video replay-edit-loading"><Film size={20} /></div>}
        <label className="option-field"><span className="option-label">Nome</span><input className="field" value={name} maxLength={80} placeholder={label} autoFocus onChange={(e) => setName(e.target.value)} /></label>
        <label className="option-field">
          <span className="option-label">Pasta</span>
          <select className="option-select" value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">Sem pasta</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="option-field"><span className="option-label">Observação</span><textarea className="field textarea" value={note} maxLength={500} placeholder="Ex.: cesta de 3 do camisa 10" onChange={(e) => setNote(e.target.value)} /></label>
        <div className="option-field">
          <span className="option-label"><Scissors size={12} /> Corte <output>{secs(Math.max(0, stop - start))} no ar</output></span>
          <div className="replay-trim">
            <label>Começa em
              <input className="field" type="number" min={0} max={Math.max(0, stop - 1)} step={0.1} value={start} onChange={(e) => setStart(Math.min(Math.max(0, Number(e.target.value) || 0), Math.max(0, stop - 1)))} />
            </label>
            <button type="button" className="btn btn-small" disabled={!url} onClick={() => setStart(Math.min(now(), Math.max(0, stop - 1)))} data-tip="Usa o ponto onde o vídeo acima está">Marcar aqui</button>
            <label>Termina em
              <input className="field" type="number" min={start + 1} max={duration} step={0.1} value={Math.round(stop * 10) / 10} onChange={(e) => setEnd(Math.min(Math.max(start + 1, Number(e.target.value) || duration), duration))} />
            </label>
            <button type="button" className="btn btn-small" disabled={!url} onClick={() => setEnd(Math.max(now(), start + 1))} data-tip="Usa o ponto onde o vídeo acima está">Marcar aqui</button>
            {(start > 0 || end !== null) && <button type="button" className="link-btn" onClick={() => { setStart(0); setEnd(null); }}>Tirar corte</button>}
          </div>
        </div>
        {!valid && <p className="device-error">O replay precisa ter pelo menos 1 segundo.</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

/** Remover uma cor da abertura: ligar, cor (código ou conta-gotas), tolerância e suavidade da borda. */
function ChromaFields({ chroma, onChange, picking, onPick }: { chroma: ChromaKey; onChange: (c: ChromaKey) => void; picking: boolean; onPick: (on: boolean) => void }) {
  const [hex, setHex] = useState(chroma.color.toUpperCase());
  useEffect(() => setHex(chroma.color.toUpperCase()), [chroma.color]);
  const set = (patch: Partial<ChromaKey>) => onChange({ ...chroma, ...patch });
  return (
    <>
      <label className="switch-row">
        <span>Remover a cor do fundo (chroma key)</span>
        <input type="checkbox" className="switch" checked={chroma.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      </label>
      <div className="chroma-row">
        <span className="chroma-swatch" style={{ background: chroma.color }} aria-hidden="true" />
        <input className="field chroma-hex-field" value={hex} maxLength={7} spellCheck={false} aria-label="Código da cor do fundo" onChange={(e) => {
          setHex(e.target.value);
          const v = e.target.value.trim();
          if (/^#?[0-9a-fA-F]{6}$/.test(v)) set({ color: `#${v.replace('#', '').toLowerCase()}`, enabled: true });
        }} />
        <button type="button" className={`btn btn-small ${picking ? 'btn-on' : ''}`} onClick={() => onPick(!picking)}><Pipette size={13} /> {picking ? 'Clique no vídeo' : 'Conta-gotas'}</button>
      </div>
      <label className="option-field">
        <span className="option-label">Tolerância <output>{Math.round(chroma.similarity * 100)}%</output></span>
        <input type="range" min={0} max={0.8} step={0.01} value={chroma.similarity} disabled={!chroma.enabled} onChange={(e) => set({ similarity: Number(e.target.value) })} />
      </label>
      <label className="option-field">
        <span className="option-label">Suavidade da borda <output>{Math.round(chroma.smoothness * 100)}%</output></span>
        <input type="range" min={0} max={0.4} step={0.01} value={chroma.smoothness} disabled={!chroma.enabled} onChange={(e) => set({ smoothness: Number(e.target.value) })} />
      </label>
    </>
  );
}

/** Cada opção do submenu Configurações › Replay abre só a sua parte. */
export type ReplaySettingsSection = 'tempo' | 'transicao' | 'abertura';

interface ReplaySettingsProps {
  section: ReplaySettingsSection;
  seconds: number;
  intro: ReplayIntro | null;
  outro: ReplayIntro | null;
  transition: ReplayTransition;
  onChange: (patch: { replaySeconds?: number; replayIntro?: ReplayIntro | null; replayOutro?: ReplayIntro | null; replayTransition?: ReplayTransition }) => void;
  onClose: () => void;
}

/** Configurações › Replay: duração do corte, transição ou vinhetas (entrada e saída), cada um no seu popup. */
export function ReplaySettingsDialog({ section, seconds, intro, outro, transition, onChange, onClose }: ReplaySettingsProps) {
  const titles: Record<ReplaySettingsSection, string> = { tempo: 'Tempo do replay', transicao: 'Transição do replay', abertura: 'Vinhetas do replay' };
  return (
    <Modal title={titles[section]} onClose={onClose} wide={section === 'abertura'}>
      <section className="settings-form">
        {section === 'tempo' && (
          <>
          <label className="option-field">
            <span className="option-label">Duração do corte <output>{seconds} segundos</output></span>
            <input type="range" min={REPLAY_MIN} max={REPLAY_MAX} step={1} value={seconds} onChange={(e) => onChange({ replaySeconds: Number(e.target.value) })} />
          </label>
          <div className="replay-scale"><span>{REPLAY_MIN} s</span><span>{REPLAY_MAX} s</span></div>
          <p className="hint">Durante a transmissão, {REPLAY_SHORTCUT} corta os últimos {seconds} segundos do que foi ao ar (pode vir até 1 s a mais, porque o corte é feito em quadros-chave). Também dá para trocar segurando o tempo na área Replay.</p>
          </>
        )}
        {section === 'transicao' && (
          <>
          <label className="option-field">
            <span className="option-label">Efeito entre as vinhetas e os replays</span>
            <select className="option-select" value={transition.kind} onChange={(e) => onChange({ replayTransition: { ...transition, kind: e.target.value as TransitionKind } })}>
              {(Object.keys(TRANSITIONS) as TransitionKind[]).map((k) => <option key={k} value={k}>{TRANSITIONS[k]}</option>)}
            </select>
          </label>
          <label className="option-field">
            <span className="option-label">Duração do efeito <output>{(transition.ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s</output></span>
            <input type="range" min={200} max={2000} step={100} value={transition.ms} disabled={transition.kind === 'corte'} onChange={(e) => onChange({ replayTransition: { ...transition, ms: Number(e.target.value) } })} />
          </label>
          <p className="hint">Vale ao entrar no replay, entre um replay e outro e na volta para a cena.</p>
          </>
        )}
        {section === 'abertura' && <VignetteTabs intro={intro} outro={outro} onChange={onChange} />}
      </section>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>Pronto</button>
      </div>
    </Modal>
  );
}

/** Abas Entrada / Saída: uma vinheta por vez na tela. */
function VignetteTabs({ intro, outro, onChange }: { intro: ReplayIntro | null; outro: ReplayIntro | null; onChange: ReplaySettingsProps['onChange'] }) {
  const [tab, setTab] = useState<VignetteKind>('entrada');
  return (
    <>
      <div className="vignette-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'entrada'} className={tab === 'entrada' ? 'on' : ''} onClick={() => setTab('entrada')}>Entrada{intro ? ' ✓' : ''}</button>
        <button type="button" role="tab" aria-selected={tab === 'saida'} className={tab === 'saida' ? 'on' : ''} onClick={() => setTab('saida')}>Saída{outro ? ' ✓' : ''}</button>
      </div>
      {tab === 'entrada' ? (
        <VignetteFields
          key="entrada"
          kind="entrada"
          title="Vinheta de entrada"
          hint="Passa no começo, sempre que você colocar um ou mais replays no ar. Entra direto por cima da imagem do Programa."
          value={intro}
          onChange={(v) => onChange({ replayIntro: v })}
        />
      ) : (
        <VignetteFields
          key="saida"
          kind="saida"
          title="Vinheta de saída"
          hint="Passa depois do último replay e, quando acaba, volta direto para a cena."
          value={outro}
          onChange={(v) => onChange({ replayOutro: v })}
        />
      )}
    </>
  );
}

/** Uma vinheta (entrada ou saída): importar, prévia, corte do começo e do fim, som e fundo removido. */
function VignetteFields({ kind, title, hint, value, onChange }: { kind: VignetteKind; title: string; hint: string; value: ReplayIntro | null; onChange: (v: ReplayIntro | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setLength(null);
    setError(null);
    if (!value) {
      setUrl(null);
      return;
    }
    let made: string | null = null;
    void window.studio.replayIntroRead(kind, value.ext).then((bytes) => {
      made = URL.createObjectURL(new Blob([bytes as BlobPart]));
      setUrl(made);
    }, () => setError('O arquivo desta vinheta não está neste computador: importe de novo.'));
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [kind, value?.ext, value?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await window.studio.replayIntroPick(kind);
      if (file) onChange({ name: file.name, ext: file.ext, start: 0, end: 0, sound: value?.sound ?? true, chroma: value?.chroma ?? { ...DEFAULT_CHROMA } });
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setBusy(false);
    }
  };

  const total = length ?? Math.max(value?.end ?? 0, (value?.start ?? 0) + 1, 1);
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const end = value && value.end > 0 ? Math.min(value.end, total) : total;
  const start = value ? Math.min(value.start, Math.max(0, end - MIN_CUT)) : 0;
  const setCut = (patch: { start?: number; end?: number }) => {
    if (!value) return;
    const s = tenth(patch.start ?? start);
    let e = tenth(patch.end ?? end);
    if (e - s < MIN_CUT) e = tenth(s + MIN_CUT);
    // Fim no fim do vídeo = "até o fim" (0): continua valendo se o arquivo for trocado por um mais longo.
    onChange({ ...value, start: s, end: length !== null && e >= tenth(length) - 0.05 ? 0 : e });
  };

  return (
    <div className="vignette-block">
      <h3 className="vignette-title">{title}</h3>
      <p className="hint">{hint}</p>
      {value ? (
        <>
          {url && (
            <VignetteEditor
              url={url}
              cut={length !== null ? { start, end } : null}
              onCut={(c) => setCut(c)}
              onLength={setLength}
              chroma={value.chroma}
              onChroma={(chroma) => onChange({ ...value, chroma })}
              picking={picking}
              setPicking={setPicking}
            />
          )}
          <div className="replay-intro-file">
            <Film size={14} />
            <span title={value.name}>{value.name}</span>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void pick()}><Upload size={13} /> Trocar</button>
            <button type="button" className="icon-btn icon-btn-remove" aria-label={`Tirar a ${title.toLowerCase()}`} data-tip={`Tirar a ${title.toLowerCase()}`} onClick={() => { void window.studio.replayIntroClear(kind); onChange(null); }}><X size={14} /></button>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={value.sound} onChange={(e) => onChange({ ...value, sound: e.target.checked })} />
            Levar o som da vinheta para a transmissão
          </label>
          <ChromaFields chroma={value.chroma} onChange={(chroma) => onChange({ ...value, chroma })} picking={picking} onPick={setPicking} />
        </>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => void pick()}><Upload size={14} /> Importar {title.toLowerCase()}</button>
      )}
      {error && <p className="device-error">{error}</p>}
    </div>
  );
}
