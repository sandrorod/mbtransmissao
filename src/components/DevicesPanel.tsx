import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Clapperboard, Ear, Eye, EyeOff, Globe, Info, Maximize2, MessageCircle, Minimize2, Mic, Pencil, Send, Play, Plus, Square, QrCode, RefreshCw, RotateCcw, Search, Settings2, SlidersHorizontal, Smartphone, SwitchCamera, Trash2, Video, Volume2, VolumeX } from 'lucide-react';
import { audioConstraints, LevelMeter, mixer } from '../audio/engine';
import { usefulFps } from '../devices/avfoundation';
import { audioType, baseName, displayName, videoType, type SystemDevice } from '../devices/identify';
import { pool, usePooledStream } from '../devices/pool';
import { SelectAll, SelectionBar, type GroupActions } from './SelectionBar';
import { phones, type PhoneStats } from '../phone/phones';
import { videoConstraints } from '../devices/videoOptions';
import { DEFAULT_TILE_SCALE, DEFAULT_VIDEO, TILE_SCALE_MAX, TILE_SCALE_MIN, type Source, type VideoMode, type WebPage } from '../types/studio';
import { LevelBar, Modal, StatusTag, VideoView } from './common';
import { startDeviceDrag, type DeviceDrag } from './ScenesPanel';

/** Pico de uma entrada (para os medidores); devolve -Infinity enquanto não há sinal. */
export function useLevel(stream: MediaStream | null): () => number {
  const meter = useRef<LevelMeter | null>(null);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;
    const created = new LevelMeter(stream);
    meter.current = created;
    return () => {
      created.dispose();
      if (meter.current === created) meter.current = null;
    };
  }, [stream]);
  return () => meter.current?.peak() ?? -Infinity;
}

export interface DeviceEntry {
  device: SystemDevice;
  /** false = só lembrado pelo projeto; o aparelho não está ligado agora. */
  present: boolean;
}

export const isPhone = (deviceId: string) => deviceId.startsWith('celular:');
export const isPage = (deviceId: string) => deviceId.startsWith('pagina:');
/** Foto ou vídeo importado (área Mídias). */
export const isMedia = (deviceId: string) => deviceId.startsWith('midia:');

function videoSummary(modes: VideoMode[] | null | undefined): { sizes: string; fps: string } {
  if (modes === undefined) return { sizes: 'Consultando o dispositivo…', fps: '' };
  if (modes === null) return { sizes: 'Informadas pelo próprio aparelho', fps: '' };
  const sizes = modes.map((m) => `${m.width}×${m.height}`).join(', ');
  const all = [...new Set(modes.flatMap((m) => usefulFps(m.fps)))].sort((a, b) => b - a);
  return { sizes, fps: all.map((f) => String(f).replace('.', ',')).join(' · ') + ' fps' };
}

/** Cartão recolhido: só nome e situação; o resto aparece ao expandir. */
/** Campo para dar um nome ao dispositivo: Enter salva, Esc cancela; vazio volta ao nome do sistema. */
export function RenameField({ label, onRename, onDone, className = '', persistent = false }: { label: string; onRename: (name: string) => void; onDone: () => void; className?: string; persistent?: boolean }) {
  const [value, setValue] = useState(displayName(label));
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    // No popup o campo continua aberto: cada Enter/saída do campo salva de novo.
    if (!persistent) done.current = true;
    if (save) onRename(value);
    onDone();
  };
  return (
    <input
      className={`field rename-field ${className}`}
      value={value}
      maxLength={60}
      autoFocus
      aria-label="Nome do dispositivo"
      placeholder={baseName(label)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function Card({ icon, name, title, status, expanded, onToggle, highlight, missing, renaming, onStartRename, onRename, onRenameDone, drag, children }: {
  icon: ReactNode;
  name: string;
  title: string;
  status: Parameters<typeof StatusTag>[0]['status'];
  expanded: boolean;
  onToggle: () => void;
  highlight?: boolean;
  missing?: boolean;
  renaming?: boolean;
  onStartRename?: () => void;
  onRename?: (name: string) => void;
  onRenameDone?: () => void;
  /** Dá para arrastar o cartão para uma cena (null = não, ex.: desconectado). */
  drag?: DeviceDrag | null;
  children: ReactNode;
}) {
  return (
    <li
      className={`device-card ${expanded ? 'device-card-open' : ''} ${highlight ? 'device-card-on' : ''} ${missing ? 'device-card-missing' : ''}`}
      draggable={Boolean(drag) && !renaming}
      onDragStart={(e) => { if (drag) startDeviceDrag(e, drag); }}
    >
      {renaming && onRename && onRenameDone ? (
        <div className="device-head">
          <ChevronDown size={14} className="chevron" />
          <span className="device-icon">{icon}</span>
          <RenameField label={title} onRename={onRename} onDone={onRenameDone} />
        </div>
      ) : (
        <button type="button" className="device-head" onClick={onToggle} onDoubleClick={(e) => { if (onStartRename) { e.preventDefault(); onStartRename(); } }} aria-expanded={expanded} title={`${title} · dois cliques para renomear`}>
          {expanded ? <ChevronDown size={14} className="chevron" /> : <ChevronRight size={14} className="chevron" />}
          <span className="device-icon">{icon}</span>
          <strong className="device-title">{name}</strong>
          <StatusTag status={status} />
        </button>
      )}
      {expanded && <div className="device-body">{children}</div>}
    </li>
  );
}

interface VideoTileProps {
  entry: DeviceEntry;
  stats: PhoneStats | null;
  modes: VideoMode[] | null | undefined;
  source: Source | undefined;
  page: WebPage | undefined;
  previewing: boolean;
  /** Marcado para as ações em grupo. */
  checked: boolean;
  onCheck: (on: boolean) => void;
  /** Está no Programa (na cena no ar): o botão vira Stop, que tira dele. */
  onAir: boolean;
  onStop: () => void;
  onPreview: () => void;
  onAdd: () => void;
  onSettings: () => void;
  onRemove: () => void;
  onFlip: () => void;
  onReload: () => void;
  onRename: (name: string) => void;
  /** Câmera/celular que pode gravar replay (null = não se aplica: página da web, câmera virtual). */
  replay: boolean | null;
  onReplay: (on: boolean) => void;
  /** Som do dispositivo (null = não tem som próprio). read = nível no mixer, em dBFS. */
  sound: { on: boolean; read: () => number } | null;
  onSound: (on: boolean) => void;
  /** Master (assume o Programa vazio) ou sobreposição (entra por cima). */
  role: 'master' | 'overlay' | null;
}

/** Situação de um aparelho de vídeo pelo que está aberto no pool. */
function useVideoStatus(device: SystemDevice, present: boolean) {
  useSyncExternalStore(pool.subscribe, pool.getVersion);
  const open = pool.list().filter((e) => e.spec.kind === 'video' && e.spec.deviceId === device.deviceId);
  const status = !present ? 'desconectado' as const : open.some((e) => e.status === 'ativo') ? 'ativo' as const : open.some((e) => e.status === 'falhou') ? 'falhou' as const : 'conectado' as const;
  const track = open.find((e) => e.stream)?.stream?.getVideoTracks()[0]?.getSettings();
  return { status, track };
}

/** Informações técnicas do aparelho de vídeo (mostradas no popup do "i"). */
function VideoSpecs({ device, modes, page, stats, track }: { device: SystemDevice; modes: VideoMode[] | null | undefined; page: WebPage | undefined; stats: PhoneStats | null; track: MediaTrackSettings | undefined }) {
  // Recepção do celular: atualiza só este quadro (o resto da tela não redesenha a cada 2 s).
  useSyncExternalStore(phones.subscribeStats, phones.getStatsVersion);
  if (isPhone(device.deviceId)) stats = phones.statsOf(device.deviceId);
  const phone = isPhone(device.deviceId);
  const isWeb = isPage(device.deviceId);
  const type = phone ? 'Celular (link / QR Code)' : isWeb ? 'Página da web' : videoType(device.label);
  const summary = videoSummary(modes);
  return (
    <dl className="device-specs">
      <dt>Tipo</dt><dd>{type}</dd>
      <dt>Nome no sistema</dt><dd title={device.label}>{baseName(device.label) || '—'}</dd>
      {isWeb && page && <><dt>Endereço</dt><dd title={page.url}>{page.url}</dd><dt>Tamanho</dt><dd>{page.width}×{page.height}</dd></>}
      {!phone && !isWeb && <><dt>Resoluções</dt><dd title={summary.sizes}>{summary.sizes}</dd>{summary.fps && <><dt>FPS</dt><dd title={summary.fps}>{summary.fps}</dd></>}</>}
      {phone && stats && (
        <>
          <dt>Recebendo</dt>
          <dd className={stats.fps > 0 && stats.fps < 24 ? 'warn-text' : ''}>{stats.width}×{stats.height} · {stats.fps} fps</dd>
          <dt>Conexão</dt>
          <dd className={stats.lost >= 2 ? 'warn-text' : ''}>{stats.codec || '—'} · {(stats.kbps / 1000).toFixed(1).replace('.', ',')} Mbps · perda {String(stats.lost).replace('.', ',')}%{stats.freezes ? ` · ${stats.freezes} travadas` : ''}</dd>
        </>
      )}
      {phone && stats?.sent && (
        <>
          <dt>Celular envia</dt>
          <dd className={stats.sent.limit !== 'none' ? 'warn-text' : ''}>
            {stats.sent.width}×{stats.sent.height} · {stats.sent.fps} fps · {(stats.sent.kbps / 1000).toFixed(1).replace('.', ',')} Mbps
            {stats.sent.limit === 'cpu' ? ' · reduzido: processador/calor do celular' : stats.sent.limit === 'bandwidth' ? ' · reduzido: rede Wi‑Fi' : stats.sent.limit === 'other' ? ' · reduzido' : ''}
          </dd>
          {stats.sent.battery !== null && <><dt>Bateria</dt><dd>{stats.sent.battery}%{stats.sent.charging ? ' · carregando' : ''}</dd></>}
        </>
      )}
      {phone && !stats && <><dt>Recebendo</dt><dd>Conectando…</dd></>}
      {!phone && track?.width ? <><dt>Recebendo</dt><dd>{track.width}×{track.height}{track.frameRate ? ` · ${Math.round(track.frameRate)} fps` : ''}</dd></> : null}
    </dl>
  );
}

/** Botão do chat do celular, com o número de mensagens não lidas. */
function PhoneChatButton({ deviceId, onOpen }: { deviceId: string; onOpen: () => void }) {
  useSyncExternalStore(phones.subscribeChat, phones.getChatVersion);
  const unread = phones.unreadOf(deviceId);
  return (
    <button type="button" className={`icon-btn tile-btn tile-chat-btn ${unread ? 'icon-btn-on' : ''}`} onClick={onOpen} aria-label={unread ? `Chat: ${unread} mensagens novas` : 'Chat com o celular'} title="Chat com quem está no celular">
      <MessageCircle size={14} />
      {unread > 0 && <span className="tile-chat-badge">{unread > 9 ? '9+' : unread}</span>}
    </button>
  );
}

/** Conversa com um celular: ler e responder. */
function PhoneChat({ deviceId, name, onClose }: { deviceId: string; name: string; onClose: () => void }) {
  useSyncExternalStore(phones.subscribeChat, phones.getChatVersion);
  const messages = phones.chatOf(deviceId);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { phones.markRead(deviceId); }, [deviceId, messages.length]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length]);
  const send = () => {
    if (!text.trim()) return;
    phones.sendChat(deviceId, text);
    setText('');
  };
  return (
    <Modal title={`Chat · ${name}`} onClose={onClose}>
      <div className="phone-chat" ref={listRef}>
        {messages.length === 0 && <p className="empty-text">Nenhuma mensagem ainda. O que você escrever aparece no celular.</p>}
        {messages.map((m, i) => (
          <div key={i} className={`phone-chat-msg ${m.from === 'estudio' ? 'phone-chat-me' : 'phone-chat-them'}`}>
            <small>{m.from === 'estudio' ? 'Estúdio' : name} · {new Date(m.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>
            {m.text}
          </div>
        ))}
      </div>
      <form className="phone-chat-send" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input className="field" value={text} maxLength={500} autoFocus placeholder="Escreva para o celular" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}><Send size={13} /> Enviar</button>
      </form>
    </Modal>
  );
}

/**
 * Telinha de uma entrada de vídeo: imagem ao vivo do que o aparelho envia, "i" com as informações,
 * nome (dois cliques para renomear) e os botões só com ícones.
 * Usa a mesma configuração da fonte (ou a da prévia): a captura é compartilhada, o aparelho não abre duas vezes.
 */
function VideoTile(p: VideoTileProps) {
  const { device, present } = p.entry;
  const { status, track } = useVideoStatus(device, present);
  const [info, setInfo] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [chatting, setChatting] = useState(false);
  const spec = present
    ? (p.source ? videoSpecOf(p.source) : { kind: 'video' as const, deviceId: device.deviceId, label: device.label, constraints: videoConstraints(DEFAULT_VIDEO) })
    : null;
  const pooled = usePooledStream(spec);
  const phone = isPhone(device.deviceId);
  const web = isPage(device.deviceId);
  const name = displayName(device.label) || 'Câmera sem nome';
  return (
    <li
      className={`video-tile ${p.previewing ? 'video-tile-on' : ''} ${!present ? 'video-tile-missing' : ''} ${p.replay === false ? 'video-tile-noreplay' : ''}`}
      draggable={present && !renaming && !info && !chatting}
      onDragStart={(e) => startDeviceDrag(e, { deviceId: device.deviceId, label: device.label, kind: 'video' })}
      title={present ? 'Arraste para uma cena para colocá-lo nela' : undefined}
    >
      <div className="tile-screen" onDoubleClick={p.onPreview} title="Dois cliques para pôr ou tirar da prévia">
        {present && <input type="checkbox" className="tile-check" checked={p.checked} aria-label={`Selecionar ${name}`} onChange={(e) => p.onCheck(e.target.checked)} onDoubleClick={(e) => e.stopPropagation()} />}
        {present ? <VideoView pooled={pooled} settings={p.source?.video} compact /> : <div className="tile-off">Desconectado</div>}
        <span className={`tile-dot status-${status}`} title={status}><i /></span>
        {p.role && <span className={`tile-role tile-role-${p.role}`} title={p.role === 'master' ? 'Master: assume o Programa quando ele fica sem câmera' : 'Sobreposição: entra por cima, sem tirar quem está no ar'}>{p.role === 'master' ? 'MASTER' : 'SOBREPÕE'}</span>}
        {p.replay !== null && <span className={`tile-replay ${p.replay ? 'tile-replay-on' : ''}`} title={p.replay ? 'Grava replay durante a transmissão' : 'Replay desligado: não grava replay'}>{p.replay ? 'REPLAY' : 'SEM REPLAY'}</span>}
        {p.sound?.on && <div className="tile-level"><LevelBar read={p.sound.read} /></div>}
        <button type="button" className="tile-info" onClick={() => setInfo(true)} aria-label={`Informações de ${name}`} title="Informações do dispositivo"><Info size={13} /></button>
      </div>
      {renaming ? (
        <RenameField label={device.label} onRename={p.onRename} onDone={() => setRenaming(false)} className="tile-rename" />
      ) : (
        <strong className="tile-name" title={`${device.label} · dois cliques para renomear`} onDoubleClick={() => setRenaming(true)}>
          {phone ? <Smartphone size={11} /> : web ? <Globe size={11} /> : <Video size={11} />}
          <span>{name}</span>
        </strong>
      )}
      <div className="tile-actions">
        <button type="button" className={`icon-btn tile-btn ${p.previewing ? 'icon-btn-on' : ''}`} onClick={p.onPreview} disabled={!present} aria-label={p.previewing ? 'Tirar da prévia' : 'Pôr na prévia'} title={p.previewing ? 'Tirar da prévia' : 'Pôr na prévia'}>
          {p.previewing ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        {p.onAir ? (
          <button type="button" className="icon-btn tile-btn tile-btn-stop" onClick={p.onStop} aria-label={`Tirar ${name} do Programa`} title="Está no Programa: clique para tirar da cena no ar"><Square size={13} /></button>
        ) : (
          <button type="button" className="icon-btn tile-btn" onClick={p.onAdd} disabled={!present} aria-label="Adicionar à cena" title="Adicionar à cena"><Play size={14} /></button>
        )}
        {phone && <button type="button" className="icon-btn tile-btn" onClick={p.onFlip} disabled={!present} aria-label="Trocar câmera" title="Alterna entre a câmera traseira e a frontal do celular"><SwitchCamera size={14} /></button>}
        <button
          type="button"
          className={`icon-btn tile-btn ${p.sound && !p.sound.on ? 'tile-btn-muted' : ''}`}
          disabled={!p.sound}
          aria-pressed={p.sound ? !p.sound.on : undefined}
          onClick={() => p.sound && p.onSound(!p.sound.on)}
          aria-label={!p.sound ? `${name} não tem som` : p.sound.on ? `Desligar o som de ${name}` : `Ligar o som de ${name}`}
          title={!p.sound ? 'Este dispositivo não tem som próprio' : p.sound.on ? 'Som ligado: clique para silenciar' : 'Som desligado: clique para ligar'}
        >
          {p.sound && !p.sound.on ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        {phone && <PhoneChatButton deviceId={device.deviceId} onOpen={() => setChatting(true)} />}
        {web && <button type="button" className="icon-btn tile-btn" onClick={p.onReload} aria-label="Recarregar" title="Recarregar a página"><RotateCcw size={14} /></button>}
        {p.replay !== null && (
          <button type="button" className={`icon-btn tile-btn ${p.replay ? 'icon-btn-on' : 'tile-btn-off'}`} aria-pressed={p.replay} onClick={() => p.onReplay(!p.replay)} aria-label={p.replay ? `Desligar o replay de ${name}` : `Ligar o replay de ${name}`} title={p.replay ? 'Replay ligado: clique para não gravar replay deste dispositivo' : 'Replay desligado: clique para gravar replay deste dispositivo'}><Clapperboard size={14} /></button>
        )}
        <button type="button" className="icon-btn tile-btn" onClick={p.onSettings} aria-label={`Configurações de ${name}`} title="Configurações"><Settings2 size={14} /></button>
        <button type="button" className="icon-btn tile-btn icon-btn-remove" onClick={p.onRemove} aria-label={`Remover ${name}`} title="Remover da lista"><Trash2 size={14} /></button>
      </div>
      {chatting && <PhoneChat deviceId={device.deviceId} name={name} onClose={() => setChatting(false)} />}
      {info && (
        <Modal title={name} onClose={() => setInfo(false)}>
          <label className="option-field">
            <span className="option-label">Nome no Estúdio</span>
            <RenameField label={device.label} onRename={p.onRename} onDone={() => undefined} persistent />
          </label>
          <StatusTag status={status} />
          <VideoSpecs device={device} modes={p.modes} page={p.page} stats={p.stats} track={track} />
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setInfo(false)}>Fechar</button>
          </div>
        </Modal>
      )}
    </li>
  );
}

interface AudioCardProps {
  entry: DeviceEntry;
  source: Source | undefined;
  testing: boolean;
  expanded: boolean;
  onToggle: () => void;
  onTest: () => void;
  onAdd: () => void;
  onSettings: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
}

function AudioCard(p: AudioCardProps) {
  const { device, present } = p.entry;
  const [renaming, setRenaming] = useState(false);
  // A entrada só é aberta com o cartão expandido (ou em teste); com a mesma configuração da fonte, é a mesma captura.
  const spec = present && (p.expanded || p.testing) ? { kind: 'audio' as const, deviceId: device.deviceId, label: device.label, constraints: audioConstraints(p.source?.audio) } : null;
  const pooled = usePooledStream(spec);
  const read = useLevel(pooled.stream);
  useEffect(() => {
    if (!p.testing) return;
    mixer.listen(pooled.stream);
    return () => mixer.listen(null);
  }, [p.testing, pooled.stream]);
  const caps = useMemo(() => pooled.stream?.getAudioTracks()[0]?.getCapabilities?.() as (MediaTrackCapabilities & { channelCount?: { max?: number } }) | undefined, [pooled.stream]);
  const settings = pooled.stream?.getAudioTracks()[0]?.getSettings();
  const channels = caps?.channelCount?.max ?? settings?.channelCount;
  const rate = settings?.sampleRate;
  const status = !present ? 'desconectado' : pooled.status === 'abrindo' || pooled.status === 'falhou' ? pooled.status : 'conectado';
  const phone = isPhone(device.deviceId);
  return (
    <Card icon={phone ? <Smartphone size={15} /> : <Mic size={15} />} name={displayName(device.label) || 'Entrada sem nome'} title={device.label} status={status} expanded={p.expanded} onToggle={p.onToggle} highlight={p.testing} missing={!present} renaming={renaming} onStartRename={() => setRenaming(true)} onRename={p.onRename} onRenameDone={() => setRenaming(false)} drag={present ? { deviceId: device.deviceId, label: device.label, kind: 'audio' } : null}>
      <dl className="device-specs">
        <dt>Tipo</dt><dd>{phone ? 'Microfone do celular' : audioType(device.label)}</dd>
        {channels ? <><dt>Canais</dt><dd>{channels}</dd></> : null}
        {rate ? <><dt>Frequência</dt><dd>{(rate / 1000).toLocaleString('pt-BR')} kHz</dd></> : null}
      </dl>
      <div className="device-signal" title="Sinal de entrada em tempo real"><LevelBar read={read} /></div>
      {pooled.error && present && <p className="device-error">{pooled.error}</p>}
      <div className="device-actions">
        <button type="button" className={`btn btn-small ${p.testing ? 'btn-on' : ''}`} onClick={p.onTest} disabled={!present || !pooled.stream} title="Ouvir esta entrada no monitoramento">
          <Ear size={13} /> {p.testing ? 'Parar teste' : 'Testar'}
        </button>
        <button type="button" className="btn btn-small" onClick={p.onAdd} disabled={!present}><SlidersHorizontal size={13} /> Adicionar ao mixer</button>
        <span className="device-actions-right">
          <button type="button" className="icon-btn" onClick={() => setRenaming(true)} aria-label={`Renomear ${device.label}`} title="Renomear"><Pencil size={14} /></button>
          <button type="button" className="icon-btn" onClick={p.onSettings} aria-label={`Configurações de ${device.label}`} title="Configurações"><Settings2 size={15} /></button>
          <button type="button" className="icon-btn icon-btn-remove" onClick={p.onRemove} aria-label={`Remover ${device.label}`} title="Remover da lista"><Trash2 size={15} /></button>
        </span>
      </div>
    </Card>
  );
}

interface Props {
  video: DeviceEntry[];
  audio: DeviceEntry[];
  modes: Record<string, VideoMode[] | null | undefined>;
  hiddenCount: number;
  sourceOf: (device: SystemDevice) => Source | undefined;
  /** O vídeo do aparelho está na cena no ar. */
  onAir: (device: SystemDevice) => boolean;
  onStopVideo: (device: SystemDevice) => void;
  pageOf: (device: SystemDevice) => WebPage | undefined;
  /** Dispositivos que estão na Prévia. */
  previewIds: Set<string>;
  /** Marcados (dispositivos e mídias juntos) e as ações em grupo. */
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  group: GroupActions;
  testingId: string | null;
  onRefresh: () => void;
  onAddPhone: () => void;
  onAddPage: () => void;
  onShowHidden: () => void;
  onPreview: (device: SystemDevice) => void;
  onTest: (device: SystemDevice) => void;
  onAddVideo: (device: SystemDevice) => void;
  onAddAudio: (device: SystemDevice) => void;
  onSettings: (device: SystemDevice, kind: 'video' | 'audio') => void;
  onRemove: (device: SystemDevice) => void;
  onFlip: (device: SystemDevice) => void;
  soundOf: (device: SystemDevice) => { on: boolean; read: () => number } | null;
  onSound: (device: SystemDevice, on: boolean) => void;
  onReloadPage: (device: SystemDevice) => void;
  onRename: (device: SystemDevice, name: string) => void;
  /** Replay ligado neste dispositivo (null = não se aplica). */
  replayOf: (device: SystemDevice) => boolean | null;
  onReplay: (device: SystemDevice, on: boolean) => void;
  roleOf: (device: SystemDevice) => 'master' | 'overlay' | null;
  /** Tamanho das miniaturas (barrinha no topo da área). */
  tileScale: number;
  onTileScale: (scale: number) => void;
}

export function DevicesPanel(props: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggle = (id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [menu]);

  const pick = (action: () => void) => () => { setMenu(false); action(); };
  const videoCard = (entry: DeviceEntry) => (
    <VideoTile
      key={entry.device.deviceId}
      entry={entry}
      modes={props.modes[entry.device.label]}
      source={props.sourceOf(entry.device)}
      page={props.pageOf(entry.device)}
      stats={isPhone(entry.device.deviceId) ? phones.statsOf(entry.device.deviceId) : null}
      previewing={props.previewIds.has(entry.device.deviceId)}
      checked={props.selected.has(entry.device.deviceId)}
      onCheck={(on) => props.onSelect([entry.device.deviceId], on)}
      onAir={props.onAir(entry.device)}
      onStop={() => props.onStopVideo(entry.device)}
      onRename={(name) => props.onRename(entry.device, name)}
      onPreview={() => props.onPreview(entry.device)}
      onAdd={() => props.onAddVideo(entry.device)}
      onSettings={() => props.onSettings(entry.device, 'video')}
      onRemove={() => props.onRemove(entry.device)}
      onFlip={() => props.onFlip(entry.device)}
      onReload={() => props.onReloadPage(entry.device)}
      replay={props.replayOf(entry.device)}
      onReplay={(on) => props.onReplay(entry.device, on)}
      role={props.roleOf(entry.device)}
      sound={props.soundOf(entry.device)}
      onSound={(on) => props.onSound(entry.device, on)}
    />
  );

  return (
    <section className="panel devices-panel" aria-label="Dispositivos conectados">
      <header className="panel-head">
        <h2 className="panel-title">Dispositivos conectados</h2>
        <label className="tile-size" title="Tamanho das miniaturas (dois cliques volta ao padrão)">
          <Minimize2 size={12} aria-hidden="true" />
          <input type="range" min={TILE_SCALE_MIN} max={TILE_SCALE_MAX} step={0.02} value={props.tileScale} onChange={(e) => props.onTileScale(Number(e.target.value))} onDoubleClick={() => props.onTileScale(DEFAULT_TILE_SCALE)} aria-label="Tamanho das miniaturas" />
          <Maximize2 size={12} aria-hidden="true" />
        </label>
        <div className="add-menu" ref={menuRef}>
          <button type="button" className="btn btn-small btn-primary" onClick={() => setMenu(!menu)} aria-expanded={menu}><Plus size={13} /> Adicionar</button>
          {menu && (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" onClick={pick(props.onAddPhone)}><QrCode size={14} /> Celular (link ou QR Code)</button>
              <button type="button" role="menuitem" onClick={pick(props.onAddPage)}><Globe size={14} /> Widget (página da web)</button>
              <button type="button" role="menuitem" onClick={pick(props.onRefresh)}><Search size={14} /> Procurar câmeras e microfones</button>
              {props.hiddenCount > 0 && <button type="button" role="menuitem" onClick={pick(props.onShowHidden)}><RefreshCw size={14} /> Mostrar removidos ({props.hiddenCount})</button>}
            </div>
          )}
        </div>
      </header>
      <div className="panel-scroll">
        <h3 className="group-title">
          Entradas de vídeo <span>{props.video.filter((e) => e.present).length}</span>
          <SelectAll ids={props.video.filter((e) => e.present).map((e) => e.device.deviceId)} selected={props.selected} onSelect={props.onSelect} label="Selecionar todas as entradas de vídeo" />
        </h3>
        <SelectionBar actions={props.group} />
        {props.video.length === 0 && <p className="empty-text">Nenhuma câmera, placa de captura ou celular.</p>}
        <ul className="video-grid" style={{ ['--tile-scale' as string]: String(props.tileScale) }}>{props.video.map(videoCard)}</ul>

        <h3 className="group-title">Entradas de áudio <span>{props.audio.filter((e) => e.present).length}</span></h3>
        {props.audio.length === 0 && <p className="empty-text">Nenhuma entrada de áudio.</p>}
        <ul className="device-list">
          {props.audio.map((entry) => (
            <AudioCard
              key={entry.device.deviceId}
              entry={entry}
              source={props.sourceOf(entry.device)}
              testing={props.testingId === entry.device.deviceId}
              expanded={open.has(entry.device.deviceId)}
              onToggle={() => toggle(entry.device.deviceId)}
              onTest={() => props.onTest(entry.device)}
              onAdd={() => props.onAddAudio(entry.device)}
              onSettings={() => props.onSettings(entry.device, 'audio')}
              onRemove={() => props.onRemove(entry.device)}
              onRename={(name) => props.onRename(entry.device, name)}
            />
          ))}
        </ul>

      </div>
    </section>
  );
}

export const videoSpecOf = (source: Source) => ({ kind: 'video' as const, deviceId: source.device.deviceId, label: source.device.label, constraints: videoConstraints(source.video) });
export const audioSpecOf = (source: Source) => ({ kind: 'audio' as const, deviceId: source.device.deviceId, label: source.device.label, constraints: audioConstraints(source.audio) });
