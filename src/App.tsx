import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Blend, Clapperboard, CloudUpload, History, FilePlus2, Film, FolderOpen, LayoutTemplate, Upload, GripHorizontal, Maximize2, Minimize2, Radio, Save, Settings2, Square, Timer } from 'lucide-react';
import { mixer } from './audio/engine';
import { audioType, baseName, displayName, findDevice, kindOf, normalizeLabel, setDeviceAliases, videoType, type DeviceChanges, type SystemDevice } from './devices/identify';
import { pageRegistry, pool } from './devices/pool';
import { mediaPlayers, mediaRegistry } from './devices/mediaPlayers';
import { MediaPanel } from './components/MediaPanel';
import { specKey } from './devices/mediaPool';
import { useSystemDevices } from './devices/useSystemDevices';
import { audioSpecOf, DevicesPanel, isMedia, isPage, isPhone, videoSpecOf, type DeviceEntry } from './components/DevicesPanel';
import { ConfirmDialog, DriveDialog, NewSessionDialog, SessionsDialog, HiddenDialog, LiveDialog, PhoneDialog, StopLiveDialog } from './components/Dialogs';
import { WidgetDialog, WidgetsPanel } from './components/Widgets';
import { MissingDevicesDialog, PermissionBar, Toasts, type Toast } from './components/Notices';
import { MixerPanel } from './components/MixerPanel';
import { AccountChip } from './components/Account';
import { ScenesPanel, type DeviceDrag, type SourceStatus } from './components/ScenesPanel';
import { SelectionPanel } from './components/SelectionPanel';
import { AudioSettingsDialog, VideoSettingsDialog } from './components/SettingsDialogs';
import { PreviewPanel, ProgramPanel } from './components/StagePanel';
import { AreaClose, AreaExpand, closePanel, DRAG_TYPE, movePanel, openPanel, openPanels, Splitter, Zone, type PanelTarget } from './components/Layout';
import { AppMenu, type MenuItem } from './components/AppMenu';
import { REPLAY_SHORTCUT, ReplayPanel, ReplaySettingsDialog, replayLabel, type ReplaySettingsSection } from './components/ReplayPanel';
import { ReplayPlayer, useReplay } from './program/replay';
import { CameraReplay, type ReplayCamera } from './program/cameraReplay';
import { phoneDeviceId, phoneIdOf, phones } from './phone/phones';
import { Compositor, fillTransform } from './program/compositor';
import { LiveController } from './program/live';
import { liveStore, sameLiveCore, useLiveMetrics } from './program/liveStore';
import { DEFAULT_AUDIO, DEFAULT_LAYOUT, isYoutubeDestination, DEFAULT_VIDEO, EMPTY_PREFERENCES, OUTPUT_PRESETS, PANEL_IDS, ROLES, type AccountView, type Border, type DeviceKind, type Layout, type PanelColumn, type PanelId, type DeviceRef, type LiveExtras, type LiveStatus, type MediaAccess, type Preferences, type Project, type SceneItem, type Source, type Transform, type VideoMode, type WebPage } from './types/studio';
import { addToScene, sceneHasDevice, createProject, ensureSource, findSource, isVirtualDevice, missingDevices, newId, realDevices, refOf, removeDeviceSources, removeSource, replaceDevice, updateDeviceIds, type MissingItem } from './utils/project';
import { validatePreferences } from './utils/validate';

const api = () => window.studio;
const IDLE: LiveStatus = { state: 'parado', startedAt: null, fps: 0, kbps: 0, message: null, destinations: [] };

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

/** Selo "AO VIVO" com relógio e Mbps: redesenha só ele a cada segundo, não a tela inteira. */
function LiveBadge({ status }: { status: LiveStatus }) {
  const metrics = useLiveMetrics();
  const live = metrics && metrics.state === status.state ? metrics : status;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className={`live-status live-${live.state}`} title={live.message ?? ''}>
      <i />{live.state === 'ao-vivo' ? `AO VIVO ${clock(now - (live.startedAt ?? now))}` : live.state === 'reconectando' ? 'Reconectando…' : live.message ?? 'Iniciando…'}
      {live.state === 'ao-vivo' && live.kbps > 0 && <small>{(live.kbps / 1000).toFixed(1).replace('.', ',')} Mbps</small>}
    </span>
  );
}

/** Peso de cada área quando o operador ainda não mexeu no tamanho. */
const PANEL_WEIGHT: Record<PanelId, number> = { dispositivos: 3, widgets: 2, midias: 1.6, previa: 1, cenas: 1.6, mixer: 1.1, selecao: 1.1, replay: 1.4 };
/** Nome de cada área (menu Exibição e botão de fechar). */
const PANEL_NAMES: Record<PanelId, string> = { dispositivos: 'Dispositivos', widgets: 'Widgets', midias: 'Mídias', previa: 'Prévia', cenas: 'Cenas', mixer: 'Mixer', selecao: 'Seleção para a transmissão', replay: 'Replay' };

/**
 * Divisão automática de uma faixa: a Prévia fica com a largura da imagem 16:9 que cabe na altura da linha
 * (tamanho proporcional) e as outras áreas dividem o resto pelos pesos.
 */
function panelDefaults(columns: PanelColumn[], width = 0, height = 0): number[] {
  const list = columns;
  // Coluna empilhada vale pelo peso da maior área dela; a Prévia só tem largura própria quando está sozinha.
  const weights = columns.map((c) => Math.max(...c.map((id) => PANEL_WEIGHT[id])));
  const preview = columns.findIndex((c) => c.length === 1 && c[0] === 'previa');
  if (preview < 0 || !width || !height || list.length === 1) {
    const total = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => w / total);
  }
  const free = width - 8 * (list.length - 1);
  // Altura útil da tela da prévia: tira título e margens do quadro.
  const previewWidth = Math.max(0, height - 62) * (16 / 9) + 26;
  const share = Math.min(Math.max(previewWidth / free, 0.15), 0.34);
  const others = weights.filter((_, i) => i !== preview).reduce((a, b) => a + b, 0);
  return weights.map((w, i) => (i === preview ? share : ((1 - share) * w) / others));
}

type Dialog =
  | { t: 'phone' }
  | { t: 'widget'; page: WebPage | null }
  | { t: 'live'; start?: boolean }
  | { t: 'hidden' }
  | { t: 'confirm'; title: string; message: string; confirm: string; run: () => void }
  | { t: 'stop' }
  | { t: 'replay-settings'; section: ReplaySettingsSection }
  | { t: 'drive' }
  | { t: 'session-new' }
  | { t: 'sessions' }
  | null;

export default function App({ account, onLogout }: { account: AccountView; onLogout: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(EMPTY_PREFERENCES);
  const [stored, setStored] = useState<{ project: Project | null; prefs: Preferences } | null>(null);
  const [access, setAccess] = useState<MediaAccess | null>(null);
  const [modes, setModes] = useState<Record<string, VideoMode[] | null | undefined>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [missing, setMissing] = useState<MissingItem[] | null>(null);
  /** Elemento selecionado na Prévia (fonte). */
  const [previewSelected, setPreviewSelected] = useState<string | null>(null);
  /** Dispositivos de vídeo e mídias marcados (ações em grupo). */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [testingId, setTestingId] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Área aberta em janela grande (popup); 'programa' = o Programa. */
  const [expanded, setExpanded] = useState<PanelId | 'programa' | null>(null);
  /** O operador já escolheu destino e qualidade nesta sessão (senão Transmitir pergunta antes). */
  const [liveChosen, setLiveChosen] = useState(false);
  const [liveStatus, setCoreStatus] = useState<LiveStatus>(IDLE);
  // Números novos vão só para o liveStore; o App inteiro só redesenha quando estado/mensagem/destinos mudam.
  const setLiveStatus = useCallback((status: LiveStatus) => {
    liveStore.set(status);
    setCoreStatus((prev) => (sameLiveCore(prev, status) ? prev : status));
  }, []);
  const [extras, setExtras] = useState<LiveExtras | null>(null);
  useEffect(() => api().onLiveExtras(setExtras), []);
  useSyncExternalStore(pool.subscribe, pool.getVersion);
  useSyncExternalStore(phones.subscribe, phones.getVersion);
  // Nomes dados pelo operador valem em toda a tela (lista, cenas, mixer, programa, avisos).
  setDeviceAliases(prefs.names);
  const workspaceRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const [leftDrop, setLeftDrop] = useState(false);
  const centerRef = useRef<HTMLDivElement>(null);

  const compositor = useMemo(() => new Compositor(1920, 1080, 30), []);
  // Prévia: compositor próprio e leve (15 quadros/s), ligado só quando há algo na Prévia.
  const previewCompositor = useMemo(() => new Compositor(1920, 1080, 15), []);
  const live = useMemo(() => new LiveController(
    (fps, method) => compositor.outputTrack(fps, method),
    () => mixer.programStream().getAudioTracks(),
    setLiveStatus,
    { frames: () => compositor.outputFrames, failures: () => compositor.outputFailures, drawn: () => compositor.drawnFps, rebuild: () => compositor.rebuildCanvas(), painted: () => compositor.paintedFps },
  ), [compositor]);
  useEffect(() => {
    compositor.start();
    // Problemas da imagem do programa vão para o registro da transmissão.
    compositor.onProblem = (message) => window.studio.liveLog(message);
    return () => compositor.stop();
  }, [compositor]);
  // Saída realmente usada na live (pode ter menos quadros que a escolhida: ver effectiveOutput).
  const [liveOutput, setLiveOutput] = useState<Preferences['output'] | null>(null);
  useEffect(() => {
    const out = liveOutput ?? prefs.output;
    compositor.configure(out.width, out.height, out.fps);
  }, [compositor, prefs.output, liveOutput]);
  useEffect(() => { void phones.start(); }, []);

  const toastId = useRef(0);
  const notify = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-4), { ...toast, id }]);
    if (!toast.sticky) setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000);
  }, []);

  const projectRef = useRef(project);
  projectRef.current = project;

  const player = useMemo(() => new ReplayPlayer(compositor, (message) => notify({ tone: 'error', icon: 'alert', title: 'Replay', text: message })), [compositor, notify]);
  const replayState = useReplay(player);
  useEffect(() => {
    void player.refresh().catch(() => undefined);
    // Som da abertura dos replays: entra no programa como um canal a mais enquanto ela passa.
    player.onIntroAudio = (stream) => {
      try {
        if (stream) mixer.update('replay:abertura', stream, DEFAULT_AUDIO);
        else mixer.remove('replay:abertura');
      } catch {
        // Vídeo sem som: a abertura passa muda.
      }
    };
    return () => player.stop();
  }, [player]);
  useEffect(() => {
    player.configure(prefs.replayIntro, prefs.replayOutro, prefs.replayTransition);
  }, [player, prefs.replayIntro, prefs.replayOutro, prefs.replayTransition]);
  // Velocidade dos replays: vale enquanto o app está aberto; sempre começa em 1x (não fica salva)
  const [replaySpeed, setReplaySpeed] = useState(1);
  useEffect(() => {
    player.setSpeed(replaySpeed);
  }, [player, replaySpeed]);

  /** Fontes e cenas afetadas por um aparelho (para avisar o operador do que caiu). */
  const usesOf = (device: SystemDevice) => {
    const p = projectRef.current;
    if (!p) return { sources: [] as Source[], scenes: [] as string[] };
    const kind: DeviceKind = device.kind === 'videoinput' ? 'video' : 'audio';
    const sources = p.sources.filter((s) => s.kind === kind && findDevice(s.device, [device], device.kind));
    const scenes = p.scenes.filter((sc) => sc.items.some((i) => sources.some((s) => s.id === i.sourceId))).map((sc) => sc.name);
    return { sources, scenes };
  };

  const typeOf = (device: SystemDevice) => (isPhone(device.deviceId) ? (device.kind === 'videoinput' ? 'Celular' : 'Microfone do celular') : isPage(device.deviceId) ? 'Página da web' : device.kind === 'videoinput' ? videoType(device.label) : audioType(device.label));

  const onDevicesChanged = useCallback((changes: DeviceChanges) => {
    for (const device of changes.removed) {
      if (isPage(device.deviceId) || isMedia(device.deviceId)) continue;
      // Celular desligado sai de tudo (cenas, programa, mixer, prévia): nada de "sem sinal" esperando por ele.
      if (isPhone(device.deviceId)) {
        setProject((p) => (p ? removeDeviceSources(p, device.deviceId, '') : p));
        removeFromPreview(device.deviceId);
        setTestingId((id) => (id === device.deviceId ? null : id));
        if (device.kind === 'videoinput') notify({ tone: 'warn', icon: 'unplug', title: `Celular desconectado: ${displayName(device.label)}`, text: 'Saiu das cenas e do programa. Para voltar, abra o link no celular de novo.' });
        continue;
      }
      if (device.kind === 'audiooutput') {
        notify({ tone: 'warn', icon: 'unplug', title: `Saída desconectada: ${displayName(device.label)}`, text: 'O monitoramento volta para a saída padrão do macOS.' });
        continue;
      }
      const { sources, scenes } = usesOf(device);
      notify({
        tone: sources.length ? 'error' : 'warn',
        icon: 'unplug',
        title: `Desconectado: ${displayName(device.label)}`,
        text: sources.length ? `${typeOf(device)} usada em ${scenes.join(', ') || 'uma fonte'}. As outras fontes continuam no ar.` : typeOf(device),
        sticky: sources.length > 0,
        action: sources[0] && !isPhone(device.deviceId) ? { label: 'Escolher outro dispositivo', run: () => setSettingsFor(sources[0].id) } : undefined,
      });
    }
    for (const device of changes.added) {
      if (isPage(device.deviceId) || isMedia(device.deviceId)) continue;
      if (device.kind === 'audiooutput') {
        notify({ tone: 'ok', icon: 'plug', title: `Nova saída de áudio: ${displayName(device.label)}` });
        continue;
      }
      const { sources } = usesOf(device);
      notify({ tone: 'ok', icon: 'plug', title: `Conectado: ${displayName(device.label)}`, text: sources.length ? `${typeOf(device)} · fonte ${displayName(sources[0].name)} de volta` : typeOf(device) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  // Celulares e páginas entram na lista junto com os aparelhos do Mac.
  const pageDevices: SystemDevice[] = (project?.pages ?? []).map((p) => ({ deviceId: `pagina:${p.id}`, groupId: p.id, label: p.name, kind: 'videoinput' }));
  const mediaDevices: SystemDevice[] = (project?.media ?? []).map((m) => ({ deviceId: `midia:${m.id}`, groupId: m.id, label: m.name, kind: 'videoinput' }));
  const extra = [...phones.devices(), ...pageDevices, ...mediaDevices];
  const { devices, ready, refresh, failures: deviceFailures } = useSystemDevices(onDevicesChanged, extra);
  // O macOS não entrega a lista de aparelhos (permissão "presa" de outra versão do app, por exemplo): oferece o
  // conserto em um clique, pensado para quem não conhece o Terminal. Aparece uma vez por abertura.
  const offeredFix = useRef(false);
  useEffect(() => {
    if (deviceFailures < 2 || offeredFix.current) return;
    offeredFix.current = true;
    notify({
      tone: 'error',
      icon: 'alert',
      title: 'O Mac não está mostrando as câmeras e microfones',
      text: 'Clique em "Corrigir permissões": o Estúdio reabre e o Mac pergunta de novo se pode usar a câmera e o microfone. Responda "Permitir" nas duas perguntas.',
      sticky: true,
      action: { label: 'Corrigir permissões', run: () => void api().resetMediaPermissions() },
    });
  }, [deviceFailures, notify]);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  // O pool precisa saber o endereço de cada página para abri-la.
  // Só fecha páginas que SAÍRAM do projeto: um widget novo ainda no editor não está no projeto e não pode ser fechado.
  const projectPageIds = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set((project?.pages ?? []).map((p) => p.id));
    for (const page of project?.pages ?? []) pageRegistry.set(page.id, page);
    for (const id of projectPageIds.current) {
      if (!ids.has(id)) {
        pageRegistry.delete(id);
        void api().closePage(id);
      }
    }
    projectPageIds.current = ids;
  }, [project?.pages]);

  // Fotos e vídeos: o pool abre pelo registro; mídia que saiu do projeto tem o tocador desligado.
  const projectMediaIds = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set((project?.media ?? []).map((m) => m.id));
    for (const item of project?.media ?? []) {
      mediaRegistry.set(item.id, item);
      mediaPlayers.update(item);
    }
    for (const id of projectMediaIds.current) {
      if (!ids.has(id)) {
        mediaRegistry.delete(id);
        mediaPlayers.close(id);
      }
    }
    projectMediaIds.current = ids;
  }, [project?.media]);

  // Perda de sinal com o aparelho ainda na lista (travou, outro app tomou): avisa, sem derrubar o resto.
  useEffect(() => {
    pool.setEvents({
      lost: (entry) => setTimeout(() => {
        const still = findDevice({ deviceId: entry.spec.deviceId, label: entry.spec.label }, devicesRef.current, kindOf(entry.spec.kind));
        if (still && !isVirtualDevice(entry.spec.deviceId)) notify({ tone: 'error', icon: 'alert', title: `Sinal perdido: ${displayName(entry.spec.label)}`, text: 'O dispositivo parou de responder. A transmissão continua com as outras fontes.', sticky: true, action: { label: 'Tentar agora', run: () => pool.retry(entry.key) } });
      }, 1500),
      recovered: (_entry, device, previousId) => {
        if (!isVirtualDevice(device.deviceId)) notify({ tone: 'ok', icon: 'ok', title: `Fonte recuperada: ${displayName(device.label)}` });
        if (previousId !== device.deviceId) setProject((p) => (p ? updateDeviceIds(p, previousId, device) : p));
      },
    });
  }, [notify]);

  useEffect(() => {
    void api().mediaAccess().then(setAccess);
    // Se a leitura falhar, abre com projeto novo e preferências padrão (antes a tela ficava em "Procurando…")
    void Promise.all([
      api().loadProject().catch((e) => { window.studio.liveLog(`abertura: projeto não lido (${String(e)})`); return null; }),
      api().loadPreferences().catch((e) => { window.studio.liveLog(`abertura: preferências não lidas (${String(e)})`); return validatePreferences(undefined); }),
    ]).then(([p, pr]) => setStored({ project: p, prefs: pr }));
    return api().onLiveStatus(() => undefined);
  }, []);

  useEffect(() => {
    if (!ready || !stored || project) return;
    setPrefs(stored.prefs);
    if (stored.project) {
      setProject(stored.project);
      // Só com a lista de aparelhos de verdade: se o sistema não respondeu, "faltariam" todos e a janela
      // confundiria (o aviso de "Corrigir permissões" trata esse caso).
      const items = deviceFailures === 0 ? missingDevices(stored.project, devices) : [];
      if (items.length) setMissing(items);
    } else {
      setProject(createProject(devices, stored.prefs));
    }
    void api().mediaAccess().then(setAccess);
  }, [ready, stored, project, devices, deviceFailures]);

  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => void api().saveProject(project).catch(() => undefined), 500);
    return () => clearTimeout(timer);
  }, [project]);

  const updatePrefs = (next: Preferences) => {
    setPrefs(next);
    void api().savePreferences(next);
  };

  // Mudanças de tamanho chegam a cada movimento do mouse: a tela atualiza na hora e o disco só depois de parar.
  const prefsSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setLayout = (patch: Partial<Layout>) => {
    setPrefs((current) => {
      const next = { ...current, layout: { ...current.layout, ...patch } };
      if (prefsSave.current) clearTimeout(prefsSave.current);
      prefsSave.current = setTimeout(() => void api().savePreferences(next), 400);
      return next;
    });
  };

  const renameDevice = (device: SystemDevice, name: string) => {
    const key = normalizeLabel(device.label);
    const clean = name.trim();
    const names = { ...prefs.names };
    if (!clean || clean === baseName(device.label)) delete names[key];
    else names[key] = clean;
    if (JSON.stringify(names) !== JSON.stringify(prefs.names)) updatePrefs({ ...prefs, names });
  };

  // Modos reais das câmeras do Mac (celulares e páginas não passam pelo AVFoundation).
  useEffect(() => {
    for (const device of realDevices(devices, 'videoinput')) {
      if (!device.label || isVirtualDevice(device.deviceId) || device.label in modes) continue;
      setModes((m) => ({ ...m, [device.label]: undefined }));
      void api().probeVideoModes(device.label).then((result) => setModes((m) => ({ ...m, [device.label]: result })), () => setModes((m) => ({ ...m, [device.label]: null })));
    }
  }, [devices, modes]);

  const monitorId = project?.monitorOutput ? findDevice(project.monitorOutput, devices, 'audiooutput')?.deviceId ?? null : null;
  useEffect(() => {
    void mixer.setMonitorOutput(monitorId).catch(() => notify({ tone: 'warn', icon: 'alert', title: 'Não foi possível usar a saída de monitoramento escolhida.' }));
  }, [monitorId, notify]);

  const isLive = liveStatus.state === 'ao-vivo' || liveStatus.state === 'iniciando' || liveStatus.state === 'reconectando';
  useEffect(() => { if (!isLive) setLiveOutput(null); }, [isLive]);
  // Durante a live, o registro mostra o que chega de cada celular: separa "celular/Wi‑Fi" de "Mac lento".
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => {
      for (const p of phones.list()) {
        const s = p.stats;
        if (!s || p.state !== 'ao-vivo') continue;
        window.studio.liveLog(`celular ${p.name}: chegando ${s.width}x${s.height} ${s.fps} quadros/s · ${s.kbps} kbps ${s.codec} · perda ${s.lost}% · congelamentos ${s.freezes}`);
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [isLive]);

  // ⌘R / Ctrl+R: corta os últimos segundos da transmissão (o menu do app não tem mais "Recarregar").
  const cutting = useRef(false);
  const cutReplay = async () => {
    if (!isLive) {
      notify({ tone: 'warn', icon: 'alert', title: 'Replay só durante a transmissão', text: `Clique em Transmitir; depois ${REPLAY_SHORTCUT} corta os últimos ${prefs.replaySeconds} s.` });
      return;
    }
    if (cutting.current) return;
    cutting.current = true;
    try {
      const clips = await api().replayCut(prefs.replaySeconds);
      // Programa primeiro, depois as câmeras (o player coloca cada um no topo da lista).
      [...clips].reverse().forEach((c) => player.add(c));
      const panelOpen = openPanels(prefs.layout).includes('replay');
      const cams = clips.filter((c) => c.source).length;
      const what = cams > 0 ? `${clips.some((c) => !c.source) ? 'Programa + ' : ''}${cams} câmera${cams > 1 ? 's' : ''}` : 'Programa';
      const real = Math.min(...clips.map((c) => c.seconds));
      const short = real < prefs.replaySeconds;
      notify({
        tone: short ? 'warn' : 'ok',
        icon: short ? 'alert' : 'ok',
        title: `Replay de ${real} s pronto · ${what}`,
        text: `${short ? `Só havia ${real} s gravados (o replay pega o vídeo desde o início da transmissão; ${prefs.replaySeconds} s ficam disponíveis ${prefs.replaySeconds} s depois de Transmitir). ` : ''}${panelOpen ? 'Está na área Replay: clique para exibir no Programa.' : 'Abra a área Replay em Menu › Exibição para exibir.'}`,
      });
    } catch (e) {
      notify({ tone: 'error', icon: 'alert', title: 'Não deu para cortar o replay', text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    } finally {
      cutting.current = false;
    }
  };
  const cutReplayRef = useRef(cutReplay);
  cutReplayRef.current = cutReplay;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'r') return;
      e.preventDefault();
      if (!e.repeat) void cutReplayRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Pessoas online, saúde do sinal e chat: o YouTube só é consultado durante a transmissão e só para o que
  // estiver ligado na barra do programa (cada consulta gasta a cota diária da API).
  const watchStats = isLive && (prefs.hud.quality || prefs.hud.viewers);
  const watchChat = isLive && prefs.hud.chat;
  useEffect(() => {
    void api().watchLiveExtras({ stats: watchStats, chat: watchChat });
  }, [watchStats, watchChat]);
  const liveRef = useRef(liveStatus);
  useEffect(() => {
    const before = liveRef.current;
    liveRef.current = liveStatus;
    // Situação da live no YouTube (conferida pelo app durante a transmissão).
    if (liveStatus.message !== before.message && liveStatus.message?.startsWith('No ar no YouTube')) notify({ tone: 'ok', icon: 'ok', title: liveStatus.message });
    if (liveStatus.message !== before.message && liveStatus.message?.startsWith('O YouTube encerrou')) notify({ tone: 'error', icon: 'alert', title: 'Live encerrada no YouTube', text: liveStatus.message, sticky: true });
    if (liveStatus.state === 'erro' && before.state !== 'erro' && !liveStatus.message?.startsWith('O YouTube encerrou')) notify({ tone: 'error', icon: 'alert', title: 'A transmissão parou', text: liveStatus.message ?? undefined, sticky: true });
    for (const d of liveStatus.destinations) {
      const was = before.destinations.find((x) => x.id === d.id);
      if (!d.ok && was?.ok !== false) notify({ tone: 'error', icon: 'alert', title: `Falha em ${d.name}`, text: `${d.error ?? ''} Os outros destinos continuam.`, sticky: true });
    }
  }, [liveStatus, notify]);

  const hidden = new Set(prefs.hidden);
  const entries = (kind: SystemDevice['kind'], deviceKind: DeviceKind): DeviceEntry[] => {
    const present = realDevices(devices, kind).filter((d) => !isPage(d.deviceId) && !isMedia(d.deviceId) && !hidden.has(normalizeLabel(d.label))).map((device) => ({ device, present: true }));
    const remembered = (project?.sources ?? [])
      .filter((s) => s.kind === deviceKind && !isVirtualDevice(s.device.deviceId) && !findDevice(s.device, devices, kind) && !hidden.has(normalizeLabel(s.device.label)))
      .filter((s, i, list) => list.findIndex((x) => normalizeLabel(x.device.label) === normalizeLabel(s.device.label)) === i)
      .map((s) => ({ device: { deviceId: s.device.deviceId, label: s.device.label, groupId: '', kind }, present: false }));
    return [...present, ...remembered];
  };

  const sourceOfDevice = (device: SystemDevice) => (project ? findSource(project, device.kind === 'videoinput' ? 'video' : 'audio', refOf(device), devices) : undefined);
  const activeScene = project?.scenes.find((s) => s.id === project.activeSceneId) ?? null;
  const sceneSources = useMemo(() => (activeScene && project ? activeScene.items.map((i) => project.sources.find((s) => s.id === i.sourceId)).filter((s): s is Source => Boolean(s)) : []), [activeScene, project]);
  // Widgets só entram no mixer quando marcados como "com som".
  const soundPages = useMemo(() => new Set([
    ...(project?.pages ?? []).filter((p) => p.audio).map((p) => `pagina:${p.id}`),
    // Vídeos da área Mídias com som também ganham canal no mixer.
    ...(project?.media ?? []).filter((m) => m.kind === 'video' && m.audio).map((m) => `midia:${m.id}`),
  ]), [project?.pages, project?.media]);
  const mixerSources = useMemo(() => sceneSources.filter((s) => s.kind === 'audio' || soundPages.has(s.device.deviceId)).map((s) => (s.audio ? s : { ...s, audio: DEFAULT_AUDIO })), [sceneSources, soundPages]);
  // Replay de cada câmera: durante a transmissão, as câmeras que estão na cena (Mac e celulares, mesmo ocultas) ficam gravando.
  // Cada gravação é mais uma codificação H.264: gravar câmeras fora da cena (ou câmeras virtuais, como a do
  // OBS) roubava processamento do Programa e a live caía para 14–20 quadros/s num Mac Intel.
  const cameraReplay = useMemo(() => new CameraReplay(), []);
  useEffect(() => () => cameraReplay.dispose(), [cameraReplay]);
  // Replay: câmeras e celulares com o replay ligado na miniatura (estejam ou não na cena no ar).
  // Páginas, mídias e câmeras virtuais nunca gravam replay.
  const replayOff = new Set(prefs.replayOff);
  const canReplay = (d: SystemDevice) => d.kind === 'videoinput' && !isPage(d.deviceId) && !isMedia(d.deviceId) && videoType(d.label) !== 'Câmera virtual';
  const replayCameras: ReplayCamera[] = devices
    .filter((d) => canReplay(d) && !hidden.has(normalizeLabel(d.label)) && !replayOff.has(normalizeLabel(d.label)))
    .map((d) => {
      const source = sourceOfDevice(d) ?? { id: '', kind: 'video' as const, name: d.label, device: refOf(d), video: DEFAULT_VIDEO };
      return { deviceId: d.deviceId, label: displayName(d.label), spec: videoSpecOf(source) };
    });
  const recordingCameras = liveStatus.state === 'ao-vivo' || liveStatus.state === 'reconectando';
  const camerasKey = JSON.stringify(replayCameras.map((c) => [c.deviceId, c.label, c.spec.constraints]));
  useEffect(() => {
    cameraReplay.sync(recordingCameras, replayCameras);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraReplay, recordingCameras, camerasKey]);
  const hiddenInScene = useMemo(() => new Set((activeScene?.items ?? []).filter((i) => i.hidden).map((i) => i.sourceId)), [activeScene]);

  /**
   * Celular na cena = câmera E microfone dele. O som do celular é um dispositivo à parte e nunca entrava
   * sozinho: o mixer não mostrava o canal e a live saía sem o som do celular (pedido do usuário em 17/11).
   * Entra uma vez a cada vez que a câmera do celular aparece na cena; se o operador tirar o microfone, fica fora
   * (até o celular sair e voltar).
   */
  const phoneMicAdded = useRef(new Set<string>());
  useEffect(() => {
    if (!project) return;
    let next = project;
    const present = new Set<string>();
    for (const scene of project.scenes) {
      for (const item of scene.items) {
        const source = project.sources.find((s) => s.id === item.sourceId);
        if (!source || source.kind !== 'video' || !isPhone(source.device.deviceId)) continue;
        const phoneId = phoneIdOf(source.device.deviceId);
        const key = `${scene.id}|${phoneId}`;
        present.add(key);
        if (phoneMicAdded.current.has(key)) continue;
        const mic = devices.find((d) => d.kind === 'audioinput' && d.deviceId === phoneDeviceId(phoneId, 'audio'));
        if (!mic) continue;
        phoneMicAdded.current.add(key);
        const inScene = scene.items.some((i) => next.sources.find((s) => s.id === i.sourceId)?.device.deviceId === mic.deviceId);
        if (!inScene) next = addToScene(next, scene.id, 'audio', refOf(mic), devices);
      }
    }
    // Celular saiu da cena: na próxima vez que voltar, o microfone entra de novo.
    for (const key of [...phoneMicAdded.current]) if (!present.has(key)) phoneMicAdded.current.delete(key);
    if (next !== project) setProject(next);
  }, [project, devices]);

  const statusOf = (source: Source): SourceStatus => {
    if (!findDevice(source.device, devices, kindOf(source.kind))) return 'desconectado';
    const entry = pool.get(specKey(source.kind === 'video' ? videoSpecOf(source) : audioSpecOf(source)));
    return entry ? entry.status : 'conectado';
  };

  const addDeviceToScene = (device: SystemDevice, kind: DeviceKind) => {
    if (!project || !activeScene) return;
    setProject(addToScene(project, activeScene.id, kind, refOf(device), devices));
    notify({ tone: 'ok', icon: 'ok', title: `${displayName(device.label)} na cena ${activeScene.name}` });
  };

  /** Miniatura solta numa cena (pode ser outra que não a do ar): entra nela, sem duplicar. */
  const dropDeviceOnScene = (sceneId: string, drag: DeviceDrag) => {
    const scene = project?.scenes.find((s) => s.id === sceneId);
    if (!project || !scene) return;
    const ref = { deviceId: drag.deviceId, label: drag.label };
    const name = displayName(drag.label);
    if (sceneHasDevice(project, sceneId, drag.kind, ref, devices)) {
      notify({ tone: 'warn', icon: 'alert', title: `${name} já está na cena ${scene.name}`, text: 'Cada dispositivo entra uma vez em cada cena.' });
      return;
    }
    setProject(addToScene(project, sceneId, drag.kind, ref, devices));
    const others = project.scenes.filter((s) => s.id !== sceneId && sceneHasDevice(project, s.id, drag.kind, ref, devices)).length;
    notify({ tone: 'ok', icon: 'ok', title: `${name} na cena ${scene.name}`, text: others ? `Também está em ${others} ${others === 1 ? 'outra cena' : 'outras cenas'}, com a mesma captura.` : undefined });
  };

  const openSettings = (device: SystemDevice, kind: DeviceKind) => {
    if (!project) return;
    if (isPage(device.deviceId)) {
      const page = project.pages.find((p) => `pagina:${p.id}` === device.deviceId);
      if (page) setDialog({ t: 'widget', page });
      return;
    }
    const { project: next, source } = ensureSource(project, kind, refOf(device), devices);
    setProject(next);
    setSettingsFor(source.id);
  };

  const removeDevice = (device: SystemDevice) => {
    if (!project) return;
    const name = displayName(device.label);
    if (isPhone(device.deviceId)) {
      setDialog({ t: 'confirm', title: 'Remover celular', message: `${name} será desconectado e sai das cenas e do mixer. Ele pode voltar pelo link ou QR Code.`, confirm: 'Remover', run: () => {
        phones.remove(phoneIdOf(device.deviceId));
        setProject((p) => (p ? removeDeviceSources(removeDeviceSources(p, `celular:${phoneIdOf(device.deviceId)}:video`, ''), `celular:${phoneIdOf(device.deviceId)}:audio`, '') : p));
      } });
      return;
    }
    if (isPage(device.deviceId)) {
      setDialog({ t: 'confirm', title: 'Remover página', message: `A página ${name} sai da lista, das cenas e do programa.`, confirm: 'Remover', run: () => {
        const id = device.deviceId.slice(7);
        setProject((p) => (p ? { ...removeDeviceSources(p, device.deviceId, ''), pages: p.pages.filter((x) => x.id !== id) } : p));
      } });
      return;
    }
    setDialog({ t: 'confirm', title: 'Remover dispositivo', message: `${name} sai da lista, das cenas e do mixer. O aparelho continua ligado no Mac; para trazê-lo de volta use Adicionar → Mostrar removidos.`, confirm: 'Remover', run: () => {
      updatePrefs({ ...prefs, hidden: [...new Set([...prefs.hidden, normalizeLabel(device.label)])] });
      setProject((p) => (p ? removeDeviceSources(p, device.deviceId, device.label) : p));
      removeFromPreview(device.deviceId);
    } });
  };

  /** Salva um widget: novo entra na lista e na cena ativa; editado atualiza a página e a fonte. */
  const savePage = (page: WebPage) => {
    if (!project) return;
    pageRegistry.set(page.id, page);
    const before = project.pages.find((p) => p.id === page.id);
    const exists = Boolean(before);
    // Ligou/desligou o som: reabre a captura (com ou sem o áudio da página).
    if (before && Boolean(before.audio) !== Boolean(page.audio)) pool.list().filter((e) => e.spec.deviceId === `pagina:${page.id}`).forEach((e) => pool.retry(e.key));
    if (exists) {
      setProject({ ...project, pages: project.pages.map((p) => (p.id === page.id ? page : p)), sources: project.sources.map((s) => (s.device.deviceId === `pagina:${page.id}` ? { ...s, name: page.name, device: { ...s.device, label: page.name } } : s)) });
      void api().openPage(page);
    } else {
      const ref = { deviceId: `pagina:${page.id}`, label: page.name };
      const withPage = { ...project, pages: [...project.pages, page] };
      setProject(activeScene ? addToScene(withPage, activeScene.id, 'video', ref, devices) : withPage);
      notify({ tone: 'ok', icon: 'ok', title: `Widget ${page.name} criado`, text: activeScene ? `Já está na cena ${activeScene.name}: ajuste a posição no programa.` : undefined });
    }
    setDialog(null);
  };

  /** Muda só a parte da página que o widget mostra (arrastando o conteúdo no programa), sem recarregar a página. */
  const setPageRegion = (pageId: string, region: WebPage['region']) => {
    const current = pageRegistry.get(pageId);
    if (current) pageRegistry.set(pageId, { ...current, region });
    setProject((p) => (p ? { ...p, pages: p.pages.map((x) => (x.id === pageId ? { ...x, region } : x)) } : p));
  };

  /** Carrega fotos/vídeos do computador: entram só na lista Mídias (ir ao ar é pelo ▶ ou pela Prévia). */
  const importMedia = async () => {
    try {
      const files = await api().mediaPick();
      if (files.length === 0) return;
      const items = files.map((f) => ({ ...f, loop: true, audio: true }));
      for (const item of items) mediaRegistry.set(item.id, item);
      setProject((p) => (p ? { ...p, media: [...(p.media ?? []), ...items] } : p));
      notify({ tone: 'ok', icon: 'ok', title: files.length > 1 ? `${files.length} mídias carregadas` : `${files[0].name} carregada`, text: 'Use ▶ para colocar no Programa ou o olho para a Prévia.' });
    } catch (e) {
      notify({ tone: 'error', icon: 'alert', title: 'Não foi possível carregar', text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    }
  };

  const updateItem = (sourceId: string, patch: { transform?: Transform | null; hidden?: boolean; locked?: boolean; fill?: SceneItem['fill']; border?: Border | null }) => {
    setProject((p) => (p && p.activeSceneId ? { ...p, scenes: p.scenes.map((s) => (s.id === p.activeSceneId ? { ...s, items: s.items.map((i) => (i.sourceId === sourceId ? { ...i, ...patch } : i)) } : s)) } : p));
  };

  const updateSource = (id: string, patch: Partial<Source>) => setProject((p) => (p ? { ...p, sources: p.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : p));

  // ----- Prévia: monta a cena antes de ir ao ar (vários elementos; a lista fica salva no projeto) -----
  const previewIds = project?.preview ?? [];
  const previewKey = previewIds.join('|');
  const previewSet = useMemo(() => new Set(previewKey ? previewKey.split('|') : []), [previewKey]);
  const previewOrdered = [...previewIds.filter((d) => !d.startsWith('midia:')), ...previewIds.filter((d) => d.startsWith('midia:'))];
  // Mídias por cima de tudo também na Prévia.
  const previewSources: Source[] = previewOrdered.flatMap((deviceId) => {
    const device = devices.find((d) => d.deviceId === deviceId && d.kind === 'videoinput');
    const source = device ? sourceOfDevice(device) : undefined;
    return source ? [source] : [];
  });
  const settingsSource = project?.sources.find((s) => s.id === settingsFor) ?? null;
  const previewActive = previewSources.length > 0;
  useEffect(() => {
    if (!previewActive) return;
    previewCompositor.start();
    return () => previewCompositor.stop();
  }, [previewActive, previewCompositor]);
  useEffect(() => {
    // Durante a live a Prévia anda a 5 quadros/s: o Mac fica livre para o Programa (que é o que vai ao ar).
    previewCompositor.configure(prefs.output.width, prefs.output.height, isLive ? 5 : 15);
  }, [previewCompositor, prefs.output.width, prefs.output.height, isLive]);

  const removeFromPreview = (deviceId: string) => setProject((p) => (p && (p.preview ?? []).includes(deviceId) ? { ...p, preview: (p.preview ?? []).filter((x) => x !== deviceId) } : p));
  /** Olho dos dispositivos, widgets e mídias: põe ou tira da Prévia. Câmera entra embaixo dos widgets da prévia. */
  const togglePreview = (deviceId: string) => {
    if (!project) return;
    const list = project.preview ?? [];
    if (list.includes(deviceId)) {
      removeFromPreview(deviceId);
      return;
    }
    const device = devices.find((d) => d.deviceId === deviceId && d.kind === 'videoinput');
    if (!device) return;
    const { project: next, source } = ensureSource(project, 'video', refOf(device), devices);
    const widget = (id: string) => id.startsWith('pagina:');
    // Mídia e widget vão por cima de tudo; câmera/celular entra embaixo dos widgets.
    const onTop = widget(deviceId) || deviceId.startsWith('midia:');
    const firstWidget = list.findIndex(widget);
    const at = onTop || firstWidget < 0 ? list.length : firstWidget;
    setProject({ ...next, preview: [...list.slice(0, at), deviceId, ...list.slice(at)] });
    setPreviewSelected(source.id);
  };
  /** Guarda um ajuste feito na Prévia na própria fonte: vai junto quando ela for para o Programa. */
  // A borda escolhida na Prévia fica guardada mesmo quando a posição/tamanho muda.
  const setStaged = (sourceId: string, staged: Source['staged']) => setProject((p) => (p ? { ...p, sources: p.sources.map((s) => (s.id === sourceId ? { ...s, staged: staged && staged.border === undefined && s.staged?.border ? { ...staged, border: s.staged.border } : staged } : s)) } : p));
  const setPreviewBorder = (sourceId: string, border: Border | null) => setProject((p) => (p ? { ...p, sources: p.sources.map((s) => (s.id === sourceId ? { ...s, staged: { transform: s.staged?.transform ?? null, ...(s.staged?.fill ? { fill: s.staged.fill } : {}), border } } : s)) } : p));
  const togglePreviewFill = (sourceId: string) => {
    const source = previewSources.find((s) => s.id === sourceId);
    if (!source) return;
    const staged = source.staged;
    if (staged?.fill) {
      setStaged(sourceId, { transform: staged.fill.before });
      return;
    }
    const frame = previewCompositor.sizes.get(sourceId);
    if (!frame) return;
    const page = project?.pages.find((p) => `pagina:${p.id}` === source.device.deviceId);
    setStaged(sourceId, { transform: fillTransform(frame, source.video, previewCompositor.size, page?.region ?? null), fill: { before: staged?.transform ?? null } });
  };
  // ----- Seleção em grupo (dispositivos de vídeo e mídias) -----
  const selectIds = (ids: string[], on: boolean) => setChecked((current) => {
    const next = new Set(current);
    for (const id of ids) if (on) next.add(id); else next.delete(id);
    return next;
  });
  const checkedIds = [...checked].filter((id) => devices.some((d) => d.deviceId === id && d.kind === 'videoinput'));
  /** Põe na Prévia todos os marcados (os que já estão ficam); câmera embaixo dos widgets, mídia/widget por cima. */
  const previewMany = (ids: string[]) => setProject((p) => {
    if (!p) return p;
    let next = p;
    let list = [...(p.preview ?? [])];
    for (const id of ids) {
      if (list.includes(id)) continue;
      const device = devicesRef.current.find((d) => d.deviceId === id && d.kind === 'videoinput');
      if (!device) continue;
      next = ensureSource(next, 'video', refOf(device), devicesRef.current).project;
      const onTop = id.startsWith('pagina:') || id.startsWith('midia:');
      const firstWidget = list.findIndex((x) => x.startsWith('pagina:'));
      const at = onTop || firstWidget < 0 ? list.length : firstWidget;
      list = [...list.slice(0, at), id, ...list.slice(at)];
    }
    return { ...next, preview: list };
  });
  const programMany = (ids: string[]) => setProject((p) => {
    if (!p || !p.activeSceneId) return p;
    let next = p;
    for (const id of ids) {
      const device = devicesRef.current.find((d) => d.deviceId === id && d.kind === 'videoinput');
      if (device) next = addToScene(next, p.activeSceneId, 'video', refOf(device), devicesRef.current);
    }
    return next;
  });
  const stopMany = (ids: string[]) => setProject((p) => {
    if (!p || !p.activeSceneId) return p;
    const out = new Set(p.sources.filter((s) => ids.includes(s.device.deviceId)).map((s) => s.id));
    return { ...p, scenes: p.scenes.map((sc) => (sc.id === p.activeSceneId ? { ...sc, items: sc.items.filter((i) => !out.has(i.sourceId)) } : sc)) };
  });
  const group = {
    count: checkedIds.length,
    onPreview: () => { previewMany(checkedIds); setChecked(new Set()); },
    onProgram: () => {
      programMany(checkedIds);
      notify({ tone: 'ok', icon: 'ok', title: `${checkedIds.length} ${checkedIds.length === 1 ? 'item' : 'itens'} no Programa` });
      setChecked(new Set());
    },
    onStop: () => {
      stopMany(checkedIds);
      notify({ tone: 'ok', icon: 'ok', title: 'Selecionados fora do ar' });
      setChecked(new Set());
    },
    onClear: () => setChecked(new Set()),
  };

  /** Leva elementos da Prévia para a cena no ar, com os ajustes feitos nela. */
  const sendToProgram = (sources: Source[]) => {
    if (!activeScene || sources.length === 0) return;
    setProject((p) => {
      if (!p || !p.activeSceneId) return p;
      let next = p;
      for (const source of sources) next = addToScene(next, p.activeSceneId, 'video', source.device, devicesRef.current);
      return next;
    });
    notify({ tone: 'ok', icon: 'ok', title: sources.length > 1 ? `${sources.length} elementos no Programa` : `${displayName(sources[0].name)} no Programa`, text: `Cena ${activeScene.name}` });
  };
  const previewInProgram = new Set(previewSources.filter((s) => activeScene?.items.some((i) => i.sourceId === s.id)).map((s) => s.id));

  const suggest = (item: MissingItem): DeviceRef | null => {
    const pref = item.kind === 'videoinput' ? prefs.camera : item.kind === 'audioinput' ? (prefs.audioInterface ?? prefs.microphone) : prefs.monitorOutput;
    const found = pref ? findDevice(pref, devices, item.kind) : null;
    return found ? refOf(found) : null;
  };

  const openProject = async () => {
    try {
      const opened = await api().openProjectFile();
      if (!opened) return;
      setProject(opened);
      const items = missingDevices(opened, devices);
      setMissing(items.length ? items : null);
    } catch (e) {
      notify({ tone: 'error', icon: 'alert', title: 'Não foi possível abrir o projeto', text: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * Transmitir: se ainda não ficou definido para onde (live existente do YouTube, uma nova, ou outro destino),
   * abre destino e qualidade antes; depois de escolhido, as próximas vezes entram direto.
   */
  const startLive = async () => {
    const list = await api().listDestinations();
    if (!liveChosen || !list.some((d) => d.enabled)) {
      setDialog({ t: 'live', start: true });
      return;
    }
    await goLive();
  };

  /**
   * 60 quadros só servem se alguma câmera da cena manda mais de 30 (celular manda no máximo 30).
   * Sem isso o Mac desenha e codifica o dobro de quadros repetidos, não aguenta o ritmo e o movimento
   * sai picotado (live real de 17/11: programa a 13–47 de 60 quadros, imagens novas 5–23/s).
   */
  const effectiveOutput = (): Preferences['output'] => {
    const out = prefs.output;
    if (out.fps <= 30) return out;
    let max = 0;
    for (const s of sceneSources) {
      if (s.kind !== 'video') continue;
      const track = pool.get(specKey(videoSpecOf(s)))?.stream?.getVideoTracks()[0];
      max = Math.max(max, track?.getSettings().frameRate ?? 0);
    }
    if (max > 31) return out;
    window.studio.liveLog(`saída em 30 quadros/s (escolhido ${out.fps}): nenhuma câmera da cena manda mais de 30`);
    return { ...out, fps: 30 };
  };

  const goLive = async () => {
    try {
      setLiveStatus({ ...IDLE, state: 'iniciando' });
      const out = effectiveOutput();
      setLiveOutput(out);
      await live.start(out);
    } catch (e) {
      setLiveOutput(null);
      setLiveStatus(IDLE);
      const text = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
      // A live do YouTube escolhida já terminou (ou foi apagada): abre a escolha de novo (nova live ou outra).
      if (/já terminou no YouTube|foi apagada no YouTube/.test(text)) {
        setLiveChosen(false);
        setDialog({ t: 'live', start: true });
        notify({ tone: 'warn', icon: 'alert', title: 'Escolha outra live', text });
        return;
      }
      notify({ tone: 'error', icon: 'alert', title: 'Não foi possível iniciar', text, sticky: true });
    }
  };

  if (!project) {
    return <div className="loading"><Radio size={28} /><p>Procurando câmeras, placas de captura e microfones…</p></div>;
  }

  // Mídias (fotos e vídeos) ficam sempre por cima de todas as câmeras e widgets, no Programa e na Prévia.
  const isMediaSource = (sourceId: string) => project?.sources.find((s) => s.id === sourceId)?.device.deviceId.startsWith('midia:') ?? false;
  // (Cálculo simples, sem hook: fica depois do retorno de "carregando".)
  const sceneItems = activeScene?.items ?? [];
  const sceneVideoItems = [...sceneItems.filter((i) => !isMediaSource(i.sourceId)), ...sceneItems.filter((i) => isMediaSource(i.sourceId))];
  // Cadeado da fonte ou da pasta dela (na cena no ar).
  const lockedIds = new Set(sceneVideoItems.filter((i) => i.locked || (i.folder && activeScene?.folders?.find((f) => f.id === i.folder)?.locked)).map((i) => i.sourceId));

  const devicesOpen = prefs.layout.left[0]?.[0] === 'dispositivos';
  const leftRest = prefs.layout.left.filter((c) => c[0] !== 'dispositivos');
  const spans = prefs.layout.spans;
  const hasSpans = (z: 'left' | 'bottom') => spans[z].top.length + spans[z].bottom.length > 0;
  const showLeftZone = leftRest.length > 0 || hasSpans('left');
  const showLeft = prefs.layout.left.length > 0 || hasSpans('left');
  const showBottom = prefs.layout.bottom.length > 0 || hasSpans('bottom');
  const isOpen = (id: PanelId) => openPanels(prefs.layout).includes(id);
  const setPanelOpen = (id: PanelId, open: boolean) => updatePrefs({ ...prefs, layout: open ? openPanel(prefs.layout, id) : closePanel(prefs.layout, id) });

  /** Botão "Tela cheia" no Programa: ocupa a tela toda sem deformar e guarda onde estava; de novo, volta para lá. */
  const toggleFill = (sourceId: string) => {
    const item = activeScene?.items.find((i) => i.sourceId === sourceId);
    const source = project.sources.find((s) => s.id === sourceId);
    if (!item || !source || lockedIds.has(sourceId)) return;
    if (item.fill) {
      updateItem(sourceId, { transform: item.fill.before, fill: undefined });
      return;
    }
    const frame = compositor.sizes.get(sourceId);
    if (!frame) return;
    const page = project.pages.find((p) => `pagina:${p.id}` === source.device.deviceId);
    // Sem deformar: se a proporção da imagem for diferente da tela, corta só o que sobra (câmera 16:9 não perde nada).
    updateItem(sourceId, { transform: fillTransform(frame, source.video, compositor.size, page?.region ?? null), fill: { before: item.transform } });
  };

  /** Menu › Layout: salva a disposição das áreas (tamanhos, áreas fechadas, indicadores do Programa e a janela) num arquivo. */
  const saveLayout = async () => {
    try {
      const path = await api().saveLayoutFile({ layout: prefs.layout, hud: prefs.hud });
      if (path) notify({ tone: 'ok', icon: 'ok', title: 'Layout salvo', text: path });
    } catch (e) {
      notify({ tone: 'error', icon: 'alert', title: 'Não foi possível salvar o layout', text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    }
  };
  /** Menu › Layout: a janela volta ao tamanho salvo e as áreas voltam exatamente para onde estavam. */
  const importLayout = async () => {
    try {
      const file = await api().openLayoutFile();
      if (!file) return;
      setExpanded(null);
      updatePrefs({ ...prefs, layout: file.layout, hud: file.hud });
      notify({ tone: 'ok', icon: 'ok', title: 'Layout importado', text: file.path });
    } catch (e) {
      notify({ tone: 'error', icon: 'alert', title: 'Não foi possível importar o layout', text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    }
  };

  const menus: { label: string; items: MenuItem[] }[] = [
    {
      label: 'Projeto',
      items: [
        { label: 'Novo projeto', icon: <FilePlus2 size={14} />, run: () => { setProject(createProject(devices, prefs)); setMissing(null); } },
        { label: 'Abrir…', icon: <FolderOpen size={14} />, run: () => void openProject() },
        'separator',
        { label: 'Nova transmissão…', icon: <Radio size={14} />, disabled: isLive, run: () => setDialog({ t: 'session-new' }) },
        { label: 'Transmissões anteriores…', icon: <History size={14} />, disabled: isLive, run: () => setDialog({ t: 'sessions' }) },
        'separator',
        { label: 'Salvar como…', icon: <Save size={14} />, run: () => void api().saveProjectFileAs(project).then((path) => path && notify({ tone: 'ok', icon: 'ok', title: 'Projeto salvo', text: path })) },
      ],
    },
    {
      label: 'Configurações',
      items: [
        { label: 'Transmissão (destinos e qualidade)…', icon: <Settings2 size={14} />, run: () => setDialog({ t: 'live' }) },
        { label: 'Google Drive (chave e pasta)…', icon: <CloudUpload size={14} />, run: () => setDialog({ t: 'drive' }) },
        {
          label: 'Replay',
          icon: <Clapperboard size={14} />,
          submenu: [
            { label: `Tempo do replay (${prefs.replaySeconds} s)…`, icon: <Timer size={14} />, hint: REPLAY_SHORTCUT.split(' ')[0], run: () => setDialog({ t: 'replay-settings', section: 'tempo' }) },
            { label: 'Transição…', icon: <Blend size={14} />, run: () => setDialog({ t: 'replay-settings', section: 'transicao' }) },
            { label: 'Vinhetas (entrada e saída)…', icon: <Film size={14} />, run: () => setDialog({ t: 'replay-settings', section: 'abertura' }) },
          ],
        },
      ],
    },
    {
      label: 'Exibição',
      items: [
        ...PANEL_IDS.map((id): MenuItem => ({ label: PANEL_NAMES[id], checked: isOpen(id), keepOpen: true, run: () => setPanelOpen(id, !isOpen(id)) })),
        'separator',
        { label: 'Restaurar disposição padrão', icon: <LayoutTemplate size={14} />, run: () => updatePrefs({ ...prefs, layout: { ...DEFAULT_LAYOUT, leftWidth: prefs.layout.leftWidth, bottomHeight: prefs.layout.bottomHeight } }) },
      ],
    },
    {
      label: 'Layout',
      items: [
        { label: 'Salvar layout…', icon: <Save size={14} />, run: () => void saveLayout() },
        { label: 'Importar layout…', icon: <Upload size={14} />, run: () => void importLayout() },
      ],
    },
  ];

  /** Leva uma área para outro lugar: ao lado (coluna nova) ou empilhada (o índice da esquerda conta "dispositivos" na posição 0). */
  const movePanelTo = (panel: PanelId, target: PanelTarget) => {
    const next = movePanel({ left: prefs.layout.left, bottom: prefs.layout.bottom, spans: prefs.layout.spans }, panel, target);
    if (!next) return;
    // Mesmas colunas em outra ordem: cada uma leva o seu tamanho junto; senão a faixa volta para o automático.
    const keys = (cols: PanelColumn[]) => cols.filter((c) => c[0] !== 'dispositivos').map((c) => c.join('+'));
    const reorder = (sizes: number[] | null, before: PanelColumn[], after: PanelColumn[]) => {
      const a = keys(before);
      const b = keys(after);
      if (a.join() === b.join()) return sizes;
      return sizes && a.length === b.length && b.every((k) => a.includes(k)) ? b.map((k) => sizes[a.indexOf(k)]) : null;
    };
    updatePrefs({
      ...prefs,
      layout: {
        ...prefs.layout,
        left: next.left,
        bottom: next.bottom,
        leftSizes: reorder(prefs.layout.leftSizes, prefs.layout.left, next.left),
        bottomSizes: reorder(prefs.layout.bottomSizes, prefs.layout.bottom, next.bottom),
        spans: next.spans,
        // Linhas da largura toda mudaram numa faixa: as alturas dela voltam a ser iguais.
        spanSizes: Object.fromEntries((['left', 'bottom'] as const).flatMap((z) => {
          const same = JSON.stringify(next.spans[z]) === JSON.stringify(prefs.layout.spans[z]);
          const saved = prefs.layout.spanSizes[z];
          return same && saved ? [[z, saved]] : [];
        })),
      },
    });
  };

  /** Tira a fonte de uma cena; fonte que não está em mais nenhuma cena deixa de existir (o dispositivo continua na lista). */
  const removeFromScene = (sceneId: string, sourceId: string) => {
    const next = { ...project, scenes: project.scenes.map((s) => (s.id === sceneId ? { ...s, items: s.items.filter((x) => x.sourceId !== sourceId) } : s)) };
    setProject(next.scenes.some((s) => s.items.some((i) => i.sourceId === sourceId)) ? next : removeSource(next, sourceId));
    if (selectedId === sourceId) setSelectedId(null);
  };
  /** Fonte de vídeo do aparelho que está na cena no ar (se houver). */
  const onAirSource = (device: SystemDevice) => {
    const source = sourceOfDevice(device);
    return source && source.kind === 'video' && activeScene?.items.some((i) => i.sourceId === source.id) ? source : null;
  };

  const panels: Record<PanelId, ReactNode> = {
    dispositivos: (
      <DevicesPanel
        video={entries('videoinput', 'video')}
        audio={entries('audioinput', 'audio')}
        modes={modes}
        hiddenCount={prefs.hidden.length}
        sourceOf={sourceOfDevice}
        pageOf={(d) => project.pages.find((p) => `pagina:${p.id}` === d.deviceId)}
        previewIds={previewSet}
        selected={checked}
        onSelect={selectIds}
        group={group}
        testingId={testingId}
        onRefresh={() => { void api().forgetVideoModes(); setModes({}); void refresh(); }}
        onAddPhone={() => setDialog({ t: 'phone' })}
        onAddPage={() => setDialog({ t: 'widget', page: null })}
        onShowHidden={() => setDialog({ t: 'hidden' })}
        onPreview={(d) => togglePreview(d.deviceId)}
        onTest={(d) => setTestingId((id) => (id === d.deviceId ? null : d.deviceId))}
        onAddVideo={(d) => addDeviceToScene(d, 'video')}
        onAir={(d) => Boolean(onAirSource(d))}
        onStopVideo={(d) => {
          const source = onAirSource(d);
          if (source && activeScene) {
            removeFromScene(activeScene.id, source.id);
            notify({ tone: 'ok', icon: 'ok', title: `${displayName(d.label)} saiu do Programa`, text: `Removido da cena ${activeScene.name}.` });
          }
        }}
        onAddAudio={(d) => addDeviceToScene(d, 'audio')}
        onSettings={openSettings}
        onRemove={removeDevice}
        onFlip={(d) => phones.command(phoneIdOf(d.deviceId), 'trocar-camera')}
        replayOf={(d) => (canReplay(d) ? !replayOff.has(normalizeLabel(d.label)) : null)}
        onReplay={(d, on) => {
          const key = normalizeLabel(d.label);
          updatePrefs({ ...prefs, replayOff: on ? prefs.replayOff.filter((k) => k !== key) : [...prefs.replayOff.filter((k) => k !== key), key] });
        }}
        onReloadPage={(d) => void api().reloadPage(d.deviceId.slice(7))}
        onRename={renameDevice}
      />
    ),
    widgets: (
      <WidgetsPanel
        pages={project.pages}
        folders={project.widgetFolders ?? []}
        onListChange={(pages, widgetFolders) => setProject((p) => (p ? { ...p, pages: pages.map((x) => ({ ...(p.pages.find((y) => y.id === x.id) ?? x), folder: x.folder ?? null })), widgetFolders } : p))}
        previewIds={previewSet}
        onNew={() => setDialog({ t: 'widget', page: null })}
        onEdit={(page) => setDialog({ t: 'widget', page })}
        onPreview={(page) => togglePreview(`pagina:${page.id}`)}
        onAdd={(page) => {
          const device = devices.find((d) => d.deviceId === `pagina:${page.id}`);
          if (device) addDeviceToScene(device, 'video');
        }}
        onReload={(page) => void api().reloadPage(page.id)}
        selectedPageId={project.sources.find((x) => x.id === selectedId)?.device.deviceId.replace(/^pagina:/, '') ?? null}
        onSelect={(page) => {
          const inScene = project.sources.find((x) => x.device.deviceId === `pagina:${page.id}` && activeScene?.items.some((i) => i.sourceId === x.id));
          if (inScene) setSelectedId(inScene.id);
          else notify({ tone: 'warn', icon: 'alert', title: `${page.name} não está na cena no ar`, text: 'Use "Adicionar à cena" para colocá-lo no Programa.' });
        }}
        onSetLink={(ids, url) => {
          const changed = project.pages.filter((p) => ids.includes(p.id)).map((p) => ({ ...p, url }));
          for (const page of changed) {
            pageRegistry.set(page.id, page);
            void api().openPage(page);
          }
          setProject((p) => (p ? { ...p, pages: p.pages.map((x) => changed.find((c) => c.id === x.id) ?? x) } : p));
          notify({ tone: 'ok', icon: 'ok', title: changed.length > 1 ? `Link trocado em ${changed.length} widgets` : `Link trocado em ${changed[0]?.name ?? 'widget'}`, text: url });
        }}
        onRemove={(page) => {
          const device = devices.find((d) => d.deviceId === `pagina:${page.id}`) ?? { deviceId: `pagina:${page.id}`, label: page.name, groupId: page.id, kind: 'videoinput' as const };
          removeDevice(device);
        }}
      />
    ),
    midias: (
      <MediaPanel
        media={project.media ?? []}
        previewIds={previewSet}
        selected={checked}
        onSelect={selectIds}
        group={group}
        inProgram={new Set((activeScene?.items ?? []).map((i) => project.sources.find((s) => s.id === i.sourceId)?.device.deviceId ?? '').filter((d) => d.startsWith('midia:')).map((d) => d.slice(6)))}
        onImport={() => void importMedia()}
        onPreview={(item) => togglePreview(`midia:${item.id}`)}
        onAdd={(item) => {
          const device = devices.find((d) => d.deviceId === `midia:${item.id}`);
          if (device) addDeviceToScene(device, 'video');
        }}
        onChange={(item) => setProject((p) => (p ? { ...p, media: (p.media ?? []).map((m) => (m.id === item.id ? item : m)) } : p))}
        onStop={(item) => {
          const source = project.sources.find((s) => s.device.deviceId === `midia:${item.id}` && activeScene?.items.some((i) => i.sourceId === s.id));
          if (source && activeScene) {
            removeFromScene(activeScene.id, source.id);
            notify({ tone: 'ok', icon: 'ok', title: `${item.name} saiu do Programa`, text: `Removida da cena ${activeScene.name}.` });
          }
        }}
        onRemove={(item) => setDialog({ t: 'confirm', title: 'Remover mídia', message: `${item.name} sai da lista, das cenas e do programa.`, confirm: 'Remover', run: () => {
          setProject((p) => (p ? { ...removeDeviceSources(p, `midia:${item.id}`, ''), media: (p.media ?? []).filter((m) => m.id !== item.id) } : p));
          removeFromPreview(`midia:${item.id}`);
          void api().mediaRemove(item.id, item.ext);
        } })}
      />
    ),
    previa: (
      <PreviewPanel
        sources={previewSources}
        compositor={previewCompositor}
        pages={project.pages}
        output={prefs.output}
        selectedId={previewSelected}
        compact={expanded !== 'previa'}
        inProgramIds={previewInProgram}
        onSelect={setPreviewSelected}
        onTransform={(id, transform) => setStaged(id, { transform })}
        onToggleFill={togglePreviewFill}
        onBorder={setPreviewBorder}
        onPageRegion={setPageRegion}
        onRemove={(id) => { const s = previewSources.find((x) => x.id === id); if (s) removeFromPreview(s.device.deviceId); }}
        onSendSelected={() => sendToProgram(previewSources.filter((s) => s.id === previewSelected))}
        onSendAll={() => sendToProgram(previewSources)}
        onExpand={expanded === 'previa' ? undefined : () => setExpanded('previa')}
      />
    ),
    cenas: (
      <ScenesPanel
        scenes={project.scenes}
        activeId={project.activeSceneId}
        sources={project.sources}
        selectedId={selectedId}
        statusOf={statusOf}
        onActivate={(id) => { setProject({ ...project, activeSceneId: id }); setSelectedId(null); }}
        onAdd={() => {
          const scene = { id: newId(), name: `CENA ${project.scenes.length + 1}`, items: [] };
          setProject({ ...project, scenes: [...project.scenes, scene], activeSceneId: scene.id });
        }}
        onRename={(id, name) => setProject({ ...project, scenes: project.scenes.map((s) => (s.id === id ? { ...s, name } : s)) })}
        onDelete={(id) => {
          const scenes = project.scenes.filter((s) => s.id !== id);
          setProject({ ...project, scenes, activeSceneId: project.activeSceneId === id ? scenes[0]?.id ?? null : project.activeSceneId });
        }}
        onRemoveSource={removeFromScene}
        onDropDevice={dropDeviceOnScene}
        onSourceSettings={(s) => {
          if (s.device.deviceId.startsWith('pagina:')) {
            const page = project.pages.find((p) => `pagina:${p.id}` === s.device.deviceId);
            if (page) setDialog({ t: 'widget', page });
          } else setSettingsFor(s.id);
        }}
        onSelect={setSelectedId}
        onToggleHidden={(id) => updateItem(id, { hidden: !activeScene?.items.find((i) => i.sourceId === id)?.hidden })}
        onToggleLock={(id) => updateItem(id, { locked: !activeScene?.items.find((i) => i.sourceId === id)?.locked })}
        onReorderScenes={(ids) => setProject((p) => (p ? { ...p, scenes: ids.map((id) => p.scenes.find((sc) => sc.id === id)!).filter(Boolean) } : p))}
        onSceneUpdate={(sceneId, patch) => setProject((p) => (p ? { ...p, scenes: p.scenes.map((sc) => (sc.id === sceneId ? { ...sc, ...patch } : sc)) } : p))}
        onReorder={(sceneId, ids) => setProject({ ...project, scenes: project.scenes.map((s) => (s.id === sceneId ? { ...s, items: ids.map((id) => s.items.find((i) => i.sourceId === id)!).filter(Boolean) } : s)) })}
      />
    ),
    mixer: (
      <MixerPanel
        // Microfones/interfaces + widgets (páginas com som) da cena ativa.
        sources={mixerSources}
        hiddenIds={hiddenInScene}
        onChange={(id, patch) => setProject((p) => (p ? { ...p, sources: p.sources.map((s) => (s.id === id && (s.audio || isPage(s.device.deviceId) || isMedia(s.device.deviceId)) ? { ...s, audio: { ...(s.audio ?? DEFAULT_AUDIO), ...patch } } : s)) } : p))}
        onSettings={(s) => setSettingsFor(s.id)}
      />
    ),
    selecao: (
      <SelectionPanel
        project={project}
        prefs={prefs}
        devices={devices.filter((d) => !isPage(d.deviceId) && !isMedia(d.deviceId))}
        activeSceneName={activeScene?.name ?? null}
        onRole={(role, ref) => {
          const roles = { ...project.roles };
          if (ref) roles[role] = ref;
          else delete roles[role];
          setProject({ ...project, roles });
        }}
        onAddRoleToScene={(role) => {
          const ref = project.roles[role];
          const device = ref ? findDevice(ref, devices, kindOf(ROLES[role].kind)) : null;
          if (device) addDeviceToScene(device, ROLES[role].kind);
        }}
        onMonitor={(monitorOutput) => setProject({ ...project, monitorOutput })}
        onPrefs={updatePrefs}
      />
    ),
    replay: (
      <ReplayPanel
        player={player}
        seconds={prefs.replaySeconds}
        onSeconds={(replaySeconds) => updatePrefs({ ...prefs, replaySeconds })}
        speed={replaySpeed}
        onSpeed={setReplaySpeed}
      />
    ),
  };
  const renderArea = (id: PanelId) => (expanded === id ? (
    <section className="stage-box area-away" aria-label={PANEL_NAMES[id]}>
      <header className="stage-head"><span className="panel-title">{PANEL_NAMES[id]}</span></header>
      <div className="area-away-body">
        <Maximize2 size={18} />
        <span>Aberta em janela grande</span>
        <button type="button" className="btn btn-small" onClick={() => setExpanded(null)}>Trazer de volta</button>
      </div>
    </section>
  ) : id === 'previa' ? (
    // Prévia no layout: só a imagem e o botão de expandir (as ferramentas ficam na janela expandida).
    panels[id]
  ) : (
    <>
      {panels[id]}
      <AreaExpand name={PANEL_NAMES[id]} onExpand={() => setExpanded(id)} />
      <AreaClose name={PANEL_NAMES[id]} onClose={() => setPanelOpen(id, false)} />
    </>
  ));

  const programPanel = (
  <ProgramPanel
    sceneName={activeScene?.name ?? null}
    compositor={compositor}
    items={sceneVideoItems}
    sources={project.sources}
    pages={project.pages}
    selectedId={selectedId}
    live={isLive}
    liveStatus={liveStatus}
    output={prefs.output}
    extras={isLive ? extras : null}
    hud={prefs.hud}
    onHud={(hud) => updatePrefs({ ...prefs, hud })}
    onSelect={setSelectedId}
    onTransform={(id, transform) => updateItem(id, { transform, fill: undefined })}
    onToggleHidden={(id) => updateItem(id, { hidden: !activeScene?.items.find((i) => i.sourceId === id)?.hidden })}
    onPageRegion={setPageRegion}
    onSceneDrop={(id) => { setProject((p) => (p && p.scenes.some((sc) => sc.id === id) ? { ...p, activeSceneId: id } : p)); setSelectedId(null); }}
    lockedIds={lockedIds}
    replay={replayState.playing ? { name: replayLabel(replayState.clips, replayState.playing), queue: replayState.queue.length } : null}
    onToggleFill={toggleFill}
    onBorder={(id, border) => updateItem(id, { border })}
    onStopReplay={() => player.stop()}
      onExpand={expanded === 'programa' ? undefined : () => setExpanded('programa')}
  />
  );

  return (
    <div className="app">
      <header className="header">
        <div className="brand"><Radio size={20} /><span className="brand-name">Estúdio ao Vivo</span></div>
        <AppMenu menus={menus} />
        <input className="field project-name" value={project.name} aria-label="Nome do projeto" onChange={(e) => setProject({ ...project, name: e.target.value })} />
        <AccountChip account={account} live={isLive} onLogout={onLogout} />
        <PermissionBar access={access} onRequest={(kind) => void api().requestAccess(kind).then(() => api().mediaAccess().then(setAccess)).then(() => refresh())} onOpenSettings={(kind) => void api().openPrivacySettings(kind)} />
        <div className="live-controls">
          {isLive && (
            <LiveBadge status={liveStatus} />
          )}
          <select
            className="quality-select"
            aria-label="Qualidade da transmissão"
            title={isLive ? 'Encerre a transmissão para trocar a qualidade' : 'Qualidade da transmissão'}
            disabled={isLive}
            value={OUTPUT_PRESETS.findIndex((p) => p.width === prefs.output.width && p.height === prefs.output.height && p.fps === prefs.output.fps)}
            onChange={(e) => {
              const p = OUTPUT_PRESETS[Number(e.target.value)];
              if (p) updatePrefs({ ...prefs, output: { ...prefs.output, width: p.width, height: p.height, fps: p.fps, bitrate: p.bitrate } });
            }}
          >
            {OUTPUT_PRESETS.findIndex((p) => p.width === prefs.output.width && p.height === prefs.output.height && p.fps === prefs.output.fps) < 0 && <option value={-1}>{prefs.output.height}p · {prefs.output.fps} fps</option>}
            {OUTPUT_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label} · {(p.bitrate / 1000).toLocaleString('pt-BR')} Mbps</option>)}
          </select>
          {isLive ? (
            <button type="button" className="btn btn-danger" onClick={() => setDialog({ t: 'stop' })}><Square size={13} /> Encerrar</button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void startLive()}><Radio size={14} /> Transmitir</button>
          )}
        </div>
      </header>

      <main
        ref={workspaceRef}
        className="workspace"
        style={{ gridTemplateColumns: showLeft ? `${prefs.layout.leftWidth}px 8px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}
      >
        {showLeft && (
        <div
          ref={leftRef}
          className="left-col"
          style={{ gridTemplateRows: devicesOpen && showLeftZone ? `minmax(0, ${prefs.layout.devicesHeight}fr) 8px minmax(0, ${1 - prefs.layout.devicesHeight}fr)` : 'minmax(0, 1fr)' }}
        >
          {/* "Dispositivos" fica sozinho em cima; soltar outra área nele a coloca embaixo dele. */}
          {devicesOpen && (
          <div
            className={`left-devices ${leftDrop ? 'left-devices-drop' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setLeftDrop(true);
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setLeftDrop(false); }}
            onDrop={(e) => {
              setLeftDrop(false);
              const moved = e.dataTransfer.getData(DRAG_TYPE) as PanelId;
              if (moved) movePanelTo(moved, { kind: 'column', zone: 'left', index: prefs.layout.left.length });
            }}
          >
            {renderArea('dispositivos')}
          </div>
          )}
          {showLeftZone && (
            <>
              {devicesOpen && <Splitter
                dir="row"
                onDrag={(_x, y) => {
                  const rect = leftRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  setLayout({ devicesHeight: Math.min(Math.max((y - rect.top - 4) / (rect.height - 8), 0.2), 0.85) });
                }}
              />}
              <Zone
                zone="left"
                columns={leftRest}
                sizes={prefs.layout.leftSizes}
                defaults={() => panelDefaults(leftRest)}
                render={renderArea}
                onResize={(leftSizes) => setLayout({ leftSizes })}
                stackSizes={prefs.layout.stackSizes}
                onStackResize={(key, sizes) => setLayout({ stackSizes: { ...prefs.layout.stackSizes, [key]: sizes } })}
                onMove={(panel, target) => movePanelTo(panel, target.kind === 'column' ? { ...target, index: target.index + (devicesOpen ? 1 : 0) } : target)}
                spans={spans.left}
                spanSizes={prefs.layout.spanSizes.left ?? null}
                onSpanResize={(sizes) => setLayout({ spanSizes: { ...prefs.layout.spanSizes, left: sizes } })}
              />
            </>
          )}
        </div>
        )}
        {showLeft && <Splitter
          dir="col"
          onDrag={(x) => {
            const rect = workspaceRef.current?.getBoundingClientRect();
            if (!rect) return;
            const max = Math.max(260, rect.width * 0.55);
            setLayout({ leftWidth: Math.round(Math.min(Math.max(x - rect.left - 12 - 4, 240), max)) });
          }}
        />}
        <div ref={centerRef} className="center" style={{ gridTemplateRows: showBottom ? `minmax(0, 1fr) 8px ${prefs.layout.bottomHeight}px` : 'minmax(0, 1fr)' }}>
          {expanded === 'programa' ? (
            <section className="stage-box area-away" aria-label="Programa">
              <header className="stage-head"><span className="panel-title">Programa</span></header>
              <div className="area-away-body">
                <Maximize2 size={18} />
                <span>Aberto em janela grande</span>
                <button type="button" className="btn btn-small" onClick={() => setExpanded(null)}>Trazer de volta</button>
              </div>
            </section>
          ) : programPanel}
          {showBottom && <Splitter
            dir="row"
            onDrag={(_x, y) => {
              const rect = centerRef.current?.getBoundingClientRect();
              if (!rect) return;
              setLayout({ bottomHeight: Math.round(Math.min(Math.max(rect.bottom - y - 4, 140), rect.height - 220)) });
            }}
          />}
          {showBottom && <Zone
            zone="bottom"
            columns={prefs.layout.bottom}
            sizes={prefs.layout.bottomSizes}
            defaults={(width, height) => panelDefaults(prefs.layout.bottom, width, height)}
            render={renderArea}
            onResize={(bottomSizes) => setLayout({ bottomSizes })}
            stackSizes={prefs.layout.stackSizes}
            onStackResize={(key, sizes) => setLayout({ stackSizes: { ...prefs.layout.stackSizes, [key]: sizes } })}
            onMove={movePanelTo}
            spans={spans.bottom}
            spanSizes={prefs.layout.spanSizes.bottom ?? null}
            onSpanResize={(sizes) => setLayout({ spanSizes: { ...prefs.layout.spanSizes, bottom: sizes } })}
          />}
        </div>
      </main>

      {settingsSource?.kind === 'video' && (
        <VideoSettingsDialog
          source={settingsSource}
          devices={devices}
          modes={modes[findDevice(settingsSource.device, devices, 'videoinput')?.label ?? settingsSource.device.label]}
          onChange={(patch) => updateSource(settingsSource.id, { video: { ...settingsSource.video!, ...patch } })}
          onDevice={(ref) => setProject(replaceDevice(project, `source:${settingsSource.id}`, ref))}
          onClose={() => setSettingsFor(null)}
        />
      )}
      {settingsSource?.kind === 'audio' && (
        <AudioSettingsDialog
          source={settingsSource}
          devices={devices}
          onChange={(patch) => updateSource(settingsSource.id, { audio: { ...settingsSource.audio!, ...patch } })}
          onDevice={(ref) => setProject(replaceDevice(project, `source:${settingsSource.id}`, ref))}
          onClose={() => setSettingsFor(null)}
        />
      )}
      {missing && (
        <MissingDevicesDialog
          items={missing}
          devices={devices}
          suggest={suggest}
          onClose={() => setMissing(null)}
          onApply={(choices) => {
            let next = project;
            for (const [id, ref] of Object.entries(choices)) next = replaceDevice(next, id, ref);
            setProject(next);
            setMissing(null);
          }}
        />
      )}
      {dialog?.t === 'phone' && <PhoneDialog publicAddress={prefs.publicAddress} onPublicAddress={(publicAddress) => updatePrefs({ ...prefs, publicAddress })} turn={prefs.turn} onTurn={(turn) => { const next = { ...prefs, turn }; setPrefs(next); void api().savePreferences(next).then(() => api().phoneLink()).then(() => phones.refreshIce()); }} onClose={() => setDialog(null)} />}
      {dialog?.t === 'widget' && <WidgetDialog page={dialog.page} onSave={savePage} onClose={() => setDialog(null)} />}
      {dialog?.t === 'live' && (
        <LiveDialog
          output={prefs.output}
          onOutput={(output) => updatePrefs({ ...prefs, output })}
          onClose={() => setDialog(null)}
          onStart={dialog.start ? () => { setDialog(null); setLiveChosen(true); void goLive(); } : undefined}
        />
      )}
      {dialog?.t === 'hidden' && <HiddenDialog hidden={prefs.hidden} onRestore={(label) => updatePrefs({ ...prefs, hidden: prefs.hidden.filter((h) => h !== label) })} onClose={() => setDialog(null)} />}
      {dialog?.t === 'stop' && (
        <StopLiveDialog
          youtube={Boolean(extras?.available) || liveStatus.destinations.some((d) => isYoutubeDestination(d.id))}
          title={extras?.title ?? null}
          onStop={(end) => {
            setDialog(null);
            // Live encerrada no YouTube: a próxima transmissão pergunta de novo para onde (nova live ou outra).
            if (end) setLiveChosen(false);
            void live.stop(end).then(() => {
              setLiveStatus(IDLE);
              notify(end
                ? { tone: 'ok', icon: 'ok', title: 'Live encerrada', text: 'A transmissão parou e a live foi finalizada no YouTube.' }
                : { tone: 'ok', icon: 'ok', title: 'Envio pausado', text: 'A live continua aberta no YouTube. Clique em Transmitir para voltar a ela.' });
            });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {expanded && (
        <AreaPopup key={expanded} title={expanded === 'programa' ? 'Programa' : PANEL_NAMES[expanded]} startFull={expanded === 'programa'} onClose={() => setExpanded(null)}>
          {expanded === 'programa' ? programPanel : panels[expanded]}
        </AreaPopup>
      )}
      {dialog?.t === 'replay-settings' && <ReplaySettingsDialog section={dialog.section} seconds={prefs.replaySeconds} intro={prefs.replayIntro} outro={prefs.replayOutro} transition={prefs.replayTransition} onChange={(patch) => updatePrefs({ ...prefs, ...patch })} onClose={() => setDialog(null)} />}
      {dialog?.t === 'drive' && <DriveDialog onClose={() => setDialog(null)} />}
      {dialog?.t === 'session-new' && <NewSessionDialog project={project} onClose={() => setDialog(null)} onDone={(name) => {
        setProject((p) => (p ? { ...p, name } : p));
        void player.refresh();
        setDialog(null);
        notify({ tone: 'ok', icon: 'ok', title: 'Nova transmissão', text: `${name} · mesma configuração, sem replays` });
      }} />}
      {dialog?.t === 'sessions' && <SessionsDialog project={project} onClose={() => setDialog(null)} onRestored={(restored) => {
        setProject(restored);
        setSelectedId(null);
        void player.refresh();
        setDialog(null);
        const items = missingDevices(restored, devices);
        setMissing(items.length ? items : null);
        notify({ tone: 'ok', icon: 'ok', title: 'Transmissão recuperada', text: restored.name });
      }} />}
      {dialog?.t === 'confirm' && <ConfirmDialog title={dialog.title} message={dialog.message} confirm={dialog.confirm} onConfirm={dialog.run} onClose={() => setDialog(null)} />}
      <Toasts toasts={toasts} onClose={(id) => setToasts((list) => list.filter((t) => t.id !== id))} />
    </div>
  );
}

/**
 * Uma área do layout aberta numa janela flutuante: arrasta pelo título, muda de tamanho pelo canto e deixa o
 * resto do layout livre (dá para ir buscando elementos enquanto ela está aberta). Esc ou o botão devolvem a área.
 * "Tela inteira" ocupa a janela toda do app (o Programa já abre assim: no layout ele é maior que a janela
 * flutuante, e ampliar não podia diminuir a imagem).
 */
function AreaPopup({ title, onClose, startFull = false, children }: { title: string; onClose: () => void; startFull?: boolean; children: ReactNode }) {
  const [full, setFull] = useState(startFull);
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [box, setBox] = useState(() => {
    const w = Math.round(Math.min(window.innerWidth * 0.62, 1200));
    const h = Math.round(Math.min(window.innerHeight * 0.7, 820));
    return { x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h };
  });
  const drag = useRef<{ mode: 'move' | 'size'; startX: number; startY: number; box: typeof box } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const start = (mode: 'move' | 'size') => (e: React.PointerEvent<HTMLElement>) => {
    if (full) return;
    if (e.button !== 0 || (mode === 'move' && (e.target as HTMLElement).closest('button'))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, box };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === 'move') {
      // Sempre deixa um pedaço do título na tela para poder arrastar de volta.
      setBox({ ...d.box, x: Math.min(Math.max(d.box.x + dx, 80 - d.box.w), window.innerWidth - 80), y: Math.min(Math.max(d.box.y + dy, 0), window.innerHeight - 40) });
    } else {
      setBox({ ...d.box, w: Math.max(360, Math.min(d.box.w + dx, window.innerWidth - d.box.x)), h: Math.max(240, Math.min(d.box.h + dy, window.innerHeight - d.box.y)) });
    }
  };
  const end = () => { drag.current = null; };
  return (
    <div className={`area-popup ${full ? 'area-popup-full' : ''}`} role="dialog" aria-label={title} style={full ? { left: 8, top: 8, width: window.innerWidth - 16, height: window.innerHeight - 16 } : { left: box.x, top: box.y, width: box.w, height: box.h }}>
      <div className="area-popup-bar" onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setFull(!full); }}>
        {!full && <GripHorizontal size={14} />}
        <span className="area-popup-title">{title}</span>
        <button type="button" className="btn btn-small" onClick={() => setFull(!full)} aria-pressed={full} data-tip={full ? 'Volta para a janela flutuante (dá para mover e mudar o tamanho)' : 'Ocupa a janela toda do app (ou dois cliques no título)'}>
          {full ? <><Minimize2 size={13} /> Janela</> : <><Maximize2 size={13} /> Tela inteira</>}
        </button>
        <button type="button" className="btn btn-small" onClick={onClose} data-tip="Devolve a área ao layout (Esc)"><Minimize2 size={13} /> Voltar ao layout</button>
      </div>
      <div className="area-popup-body">{children}</div>
      {!full && <div className="area-popup-resize" aria-label="Mudar o tamanho da janela" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />}
    </div>
  );
}
