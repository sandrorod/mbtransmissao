import { type ChromaKey, ASPECTS, DEFAULT_REPLAY_SECONDS, DEFAULT_TRANSITION, INTRO_EXTENSIONS, TRANSITIONS, type ReplayIntro, type ReplayTransition, type ZoneSpans, REPLAY_MAX, REPLAY_MIN, type ClosedPanel, type PanelColumn, type SceneFolder, type ZoneId, DEFAULT_AUDIO, DEFAULT_CHROMA, DEFAULT_HUD, DEFAULT_LAYOUT, DEFAULT_OUTPUT, OLD_DEFAULT_BITRATE, PANEL_IDS, DEFAULT_VIDEO, EMPTY_PREFERENCES, ROLES, ROTATIONS, type AudioSettings, type DeviceRef, type Layout, type OutputSettings, type PanelId, type LayoutFile, type ProgramHud, type WindowState, type Preferences, type Project, type SceneItem, type Source, type Border, BORDER_STYLES, type Transform, type TurnServer, type WebPage, type MediaItem, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, REPLAY_SPEEDS } from '../types/studio';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 300) => typeof v === 'string' && v.length <= max;
const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function fail(reason: string): never {
  throw new Error(`Projeto inválido: ${reason}.`);
}

function deviceRef(v: unknown): DeviceRef | null {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || !text(v.deviceId) || !text(v.label)) fail('dispositivo');
  return { deviceId: v.deviceId as string, label: v.label as string };
}

function source(v: unknown): Source {
  if (!isObject(v) || !text(v.id, 64) || !text(v.name, 120) || (v.kind !== 'video' && v.kind !== 'audio')) fail('fonte');
  const device = deviceRef(v.device);
  if (!device) fail('dispositivo da fonte');
  if (v.kind === 'video') {
    const s = { ...DEFAULT_VIDEO, ...(isObject(v.video) ? v.video : {}) };
    if (!num(s.width, 0, 10000) || !num(s.height, 0, 10000) || !num(s.fps, 0, 1000)) fail('captura de vídeo');
    if (!ASPECTS.includes(s.aspect) || !(ROTATIONS as readonly number[]).includes(s.rotation) || typeof s.mirror !== 'boolean') fail('imagem da fonte');
    if (!isObject(s.extra) || !Object.values(s.extra).every((x) => num(x, -1e6, 1e6))) fail('parâmetros da câmera');
    // Widget (página) tem também o som dela no mixer: volume/mudo ficam guardados na fonte de vídeo.
    const page = device.deviceId.startsWith('pagina:') && isObject(v.audio) ? { audio: audioSettings(v.audio) } : {};
    // Ajustes da Prévia: inválidos são esquecidos (a fonte continua).
    let staged: Source['staged'] | undefined;
    if (isObject(v.staged)) {
      try {
        const border = borderOf(v.staged.border);
        staged = { transform: transform(v.staged.transform), ...(isObject(v.staged.fill) ? { fill: { before: transform(v.staged.fill.before) } } : {}), ...(border ? { border } : {}) };
      } catch {
        staged = undefined;
      }
    }
    return { id: v.id as string, kind: 'video', name: v.name as string, device, video: s, ...page, ...(staged ? { staged } : {}) };
  }
  return { id: v.id as string, kind: 'audio', name: v.name as string, device, audio: audioSettings(v.audio) };
}

function audioSettings(v: unknown): AudioSettings {
  const a = { ...DEFAULT_AUDIO, ...(isObject(v) ? v : {}) };
  if (!(a.channel === 'all' || num(a.channel, 0, 63)) || !num(a.sampleRate, 0, 384000) || !num(a.volume, 0, 2)) fail('áudio da fonte');
  const flags = [a.stereo, a.muted, a.monitor, a.noiseSuppression, a.echoCancellation, a.autoGainControl, a.highPass];
  if (!flags.every((f) => typeof f === 'boolean')) fail('filtros de áudio');
  return a as AudioSettings;
}

function transform(v: unknown): Transform | null {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || !num(v.x, -10, 10) || !num(v.y, -10, 10) || !num(v.w, 0.001, 20) || !isObject(v.crop)) fail('posição da fonte');
  const c = v.crop;
  if (![c.l, c.t, c.r, c.b].every((x) => num(x, 0, 0.98)) || (c.l as number) + (c.r as number) > 0.98 || (c.t as number) + (c.b as number) > 0.98) fail('corte da fonte');
  if (v.h !== undefined && !num(v.h, 0.001, 20)) fail('posição da fonte');
  return { x: v.x as number, y: v.y as number, w: v.w as number, ...(v.h === undefined ? {} : { h: v.h as number }), crop: { l: c.l as number, t: c.t as number, r: c.r as number, b: c.b as number } };
}

/** Só endereços da web comuns: nada de file:, javascript: etc. */
export function validPageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2000) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function page(v: unknown): WebPage {
  if (!isObject(v) || !text(v.id, 64) || !text(v.name, 120) || !validPageUrl(v.url) || !num(v.width, 160, 3840) || !num(v.height, 120, 2160)) fail('página da web');
  const r = v.region;
  const region = isObject(r) && num(r.x, 0, 1) && num(r.y, 0, 1) && num(r.w, 0.01, 1) && num(r.h, 0.01, 1) && (r.x as number) + (r.w as number) <= 1.0001 && (r.y as number) + (r.h as number) <= 1.0001
    ? { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number }
    : null;
  const chroma = chromaOf(v.chroma);
  const sc = v.scroll;
  const scroll = isObject(sc) && num(sc.x, 0, 4000) && num(sc.y, 0, 4000) && num(sc.top, 0, 1e6) && num(sc.left, 0, 1e6)
    ? { x: sc.x as number, y: sc.y as number, top: sc.top as number, left: sc.left as number }
    : null;
  return { id: v.id as string, name: v.name as string, url: v.url as string, width: Math.round(v.width as number), height: Math.round(v.height as number), region, chroma, scroll, audio: v.audio === true, folder: typeof v.folder === 'string' ? v.folder : null };
}

function chromaOf(v: unknown): ChromaKey {
  const c = isObject(v) ? v : {};
  return {
    enabled: c.enabled === true,
    color: typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : DEFAULT_CHROMA.color,
    similarity: num(c.similarity, 0, 1) ? (c.similarity as number) : DEFAULT_CHROMA.similarity,
    smoothness: num(c.smoothness, 0, 1) ? (c.smoothness as number) : DEFAULT_CHROMA.smoothness,
  };
}

/** Borda da fonte: inválida = sem borda. */
export function borderOf(v: unknown): Border | null {
  if (!isObject(v) || typeof v.style !== 'string' || !(v.style in BORDER_STYLES)) return null;
  return {
    style: v.style as Border['style'],
    color: typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : '#ffffff',
    width: num(v.width, 1, 40) ? Math.round(v.width as number) : 6,
    radius: num(v.radius, 0, 200) ? Math.round(v.radius as number) : 0,
  };
}

/** Posição de antes do "Tela cheia" (inválida = esquece, a fonte fica como está). */
function fillOf(v: unknown): { fill?: { before: Transform | null } } {
  if (!isObject(v)) return {};
  try {
    return { fill: { before: transform(v.before) } };
  } catch {
    return {};
  }
}

/** Vídeo de abertura dos replays. */
export function replayIntro(v: unknown): ReplayIntro | null {
  if (!isObject(v) || !text(v.name, 200) || !(INTRO_EXTENSIONS as readonly unknown[]).includes(v.ext)) return null;
  const tenth = (n: unknown, max: number) => (num(n, 0, max) ? Math.round((n as number) * 10) / 10 : 0);
  const start = tenth(v.start, 3600);
  // Formato antigo: "seconds" = quanto passava desde o começo (vira o corte do fim).
  let end = 'end' in v ? tenth(v.end, 3600) : tenth(v.seconds, 120);
  if (end > 0 && end <= start) end = 0;
  return { name: v.name as string, ext: v.ext as string, start, end, sound: v.sound !== false, chroma: chromaOf(v.chroma) };
}

export function replayTransition(v: unknown): ReplayTransition {
  if (!isObject(v) || typeof v.kind !== 'string' || !(v.kind in TRANSITIONS)) return { ...DEFAULT_TRANSITION };
  return { kind: v.kind as ReplayTransition['kind'], ms: num(v.ms, 100, 3000) ? Math.round(v.ms as number) : DEFAULT_TRANSITION.ms };
}

function folderList(v: unknown): SceneFolder[] {
  return (Array.isArray(v) ? v : []).flatMap((f: unknown) => (isObject(f) && text(f.id, 64) && text(f.name, 120) ? [{ id: f.id as string, name: f.name as string, collapsed: f.collapsed === true, locked: f.locked === true }] : [])).slice(0, 100);
}

/** Confere tudo o que vem do disco ou da interface antes de usar. */
export function validateProject(value: unknown): Project {
  if (!isObject(value) || value.version !== 1) fail('versão não suportada');
  if (!text(value.name, 200)) fail('nome');
  if (!Array.isArray(value.sources) || !Array.isArray(value.scenes)) fail('listas');
  const rawPages: unknown[] = Array.isArray(value.pages) ? value.pages : [];
  const widgetFolders = folderList(value.widgetFolders);
  const widgetFolderIds = new Set(widgetFolders.map((f) => f.id));
  const pages = rawPages.map(page).map((p) => (p.folder && widgetFolderIds.has(p.folder) ? p : { ...p, folder: null }));
  // Versões anteriores guardavam o cadeado no widget: ele passa para as fontes desse widget nas cenas.
  const lockedPages = new Set(rawPages.filter((p) => isObject(p) && p.locked === true).map((p) => `pagina:${(p as { id: string }).id}`));
  const sources = value.sources.map(source);
  const lockedSources = new Set(sources.filter((s) => lockedPages.has(s.device.deviceId)).map((s) => s.id));
  const ids = new Set(sources.map((s) => s.id));
  const scenes = value.scenes.map((sc: unknown) => {
    if (!isObject(sc) || !text(sc.id, 64) || !text(sc.name, 120)) fail('cena');
    // Projetos da primeira versão guardavam só a lista de ids: viram camadas encaixadas na tela.
    const raw: unknown[] = Array.isArray(sc.items) ? sc.items : Array.isArray(sc.sourceIds) ? (sc.sourceIds as unknown[]).map((id) => ({ sourceId: id, transform: null, hidden: false })) : fail('fontes da cena');
    const items: SceneItem[] = raw.flatMap((it) => {
      if (!isObject(it) || typeof it.sourceId !== 'string' || !ids.has(it.sourceId)) return [];
      return [{ sourceId: it.sourceId, transform: transform(it.transform), hidden: it.hidden === true, folder: typeof it.folder === 'string' ? it.folder : null, ...(it.locked === true || lockedSources.has(it.sourceId) ? { locked: true } : {}), ...fillOf(it.fill), ...(borderOf(it.border) ? { border: borderOf(it.border) } : {}) }];
    });
    const folders = folderList(sc.folders);
    const known = new Set(folders.map((f) => f.id));
    return { id: sc.id as string, name: sc.name as string, items: items.map((i) => (i.folder && known.has(i.folder) ? i : { ...i, folder: null })), folders };
  });
  const roles: Project['roles'] = {};
  if (isObject(value.roles)) {
    for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      const ref = deviceRef(value.roles[role]);
      if (ref) roles[role] = ref;
    }
  }
  const active = typeof value.activeSceneId === 'string' && scenes.some((s) => s.id === value.activeSceneId) ? value.activeSceneId : scenes[0]?.id ?? null;
  // Fotos e vídeos: só itens com id e extensão conhecidos (o arquivo fica na pasta do app); inválidos somem.
  const media = (Array.isArray(value.media) ? value.media : []).flatMap((m): MediaItem[] => {
    if (!isObject(m) || typeof m.id !== 'string' || !/^[a-f0-9-]{36}$/.test(m.id) || !text(m.name, 120) || typeof m.ext !== 'string') return [];
    const ext = m.ext.toLowerCase();
    const kind = (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? 'imagem' : (VIDEO_EXTENSIONS as readonly string[]).includes(ext) ? 'video' : null;
    if (!kind) return [];
    return [{ id: m.id, name: m.name as string, ext, kind, loop: m.loop !== false, audio: m.audio !== false }];
  }).slice(0, 300);
  return { version: 1, name: value.name as string, sources, scenes, activeSceneId: active, roles, monitorOutput: deviceRef(value.monitorOutput), pages, widgetFolders, media,
    preview: (Array.isArray(value.preview) ? value.preview : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300).slice(0, 60) };
}


/** TURN: só endereços turn:/turns: (separados por vírgula), usuário e senha curtos. */
export function turnServer(value: unknown): TurnServer | null {
  if (!isObject(value)) return null;
  const urls = typeof value.urls === 'string' ? value.urls.split(',').map((u) => u.trim()).filter(Boolean) : [];
  if (urls.length === 0 || urls.length > 6 || !urls.every((u) => /^turns?:[A-Za-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/.test(u))) return null;
  const username = typeof value.username === 'string' ? value.username.trim().slice(0, 200) : '';
  const credential = typeof value.credential === 'string' ? value.credential.trim().slice(0, 200) : '';
  if (!username || !credential) return null;
  return { urls: urls.join(','), username, credential };
}
export function validatePreferences(value: unknown): Preferences {
  if (!isObject(value)) return { ...EMPTY_PREFERENCES };
  try {
    return {
      camera: deviceRef(value.camera),
      microphone: deviceRef(value.microphone),
      audioInterface: deviceRef(value.audioInterface),
      monitorOutput: deviceRef(value.monitorOutput),
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((h): h is string => text(h)).slice(0, 200) : [],
      replayOff: Array.isArray(value.replayOff) ? value.replayOff.filter((h): h is string => text(h)).slice(0, 200) : [],
      programFirst: value.programFirst === true,
      selectionOpen: value.selectionOpen === true,
      output: output(value.output),
      publicAddress: typeof value.publicAddress === 'string' && (value.publicAddress === '' || validPageUrl(value.publicAddress)) ? value.publicAddress : '',
      turn: turnServer(value.turn),
      names: names(value.names),
      layout: layout(value.layout),
      hud: hudOf(value.hud),
      replaySeconds: num(value.replaySeconds, REPLAY_MIN, REPLAY_MAX) ? Math.round(value.replaySeconds as number) : DEFAULT_REPLAY_SECONDS,
      replayIntro: replayIntro(value.replayIntro),
      replayOutro: replayIntro(value.replayOutro),
      replayTransition: replayTransition(value.replayTransition),
      replaySpeed: (REPLAY_SPEEDS as readonly number[]).includes(value.replaySpeed as number) ? (value.replaySpeed as number) : 1,
    };
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
}

/** Qualidade da transmissão: só valores que viram parâmetros seguros do FFmpeg. */
export function output(v: unknown): OutputSettings {
  if (!isObject(v)) return { ...DEFAULT_OUTPUT };
  const ok = num(v.width, 320, 3840) && num(v.height, 240, 2160) && (v.fps === 30 || v.fps === 60 || v.fps === 25 || v.fps === 24) && num(v.bitrate, 500, 51000) && (v.encoder === 'hardware' || v.encoder === 'x264');
  if (!ok) return { ...DEFAULT_OUTPUT };
  const width = Math.round(v.width as number / 2) * 2;
  const height = Math.round(v.height as number / 2) * 2;
  // Ainda no padrão antigo (1080p30 a 6000k): sobe para o padrão novo.
  const oldDefault = width === 1920 && height === 1080 && v.fps === 30 && v.bitrate === OLD_DEFAULT_BITRATE;
  return { width, height, fps: v.fps as number, bitrate: oldDefault ? DEFAULT_OUTPUT.bitrate : Math.round(v.bitrate as number), encoder: v.encoder as OutputSettings['encoder'] };
}

/** Nomes dados aos dispositivos: só textos curtos. */
function names(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  const result: Record<string, string> = {};
  for (const [key, name] of Object.entries(v).slice(0, 300)) {
    if (text(key) && typeof name === 'string' && name.trim() && name.length <= 60) result[key] = name.trim();
  }
  return result;
}

/**
 * Disposição das áreas: cada área aparece uma única vez (aberta numa coluna ou fechada); tamanhos inválidos voltam
 * para o automático. Aceita o formato antigo (uma área por coluna). Área nova entra no fim da coluna da esquerda.
 */
export function layout(v: unknown): Layout {
  if (!isObject(v) || !Array.isArray(v.left) || !Array.isArray(v.bottom)) return { ...DEFAULT_LAYOUT };
  const isPanel = (x: unknown): x is PanelId => (PANEL_IDS as readonly unknown[]).includes(x);
  const columns = (list: unknown[]): PanelColumn[] | null => {
    const out = list.map((c) => (typeof c === 'string' ? [c] : Array.isArray(c) ? c : null));
    return out.every((c) => c && c.length > 0 && c.every(isPanel)) ? (out as PanelColumn[]) : null;
  };
  const left = columns(v.left);
  const bottom = columns(v.bottom);
  if (!left || !bottom) return { ...DEFAULT_LAYOUT };
  const rawSpans = isObject(v.spans) ? v.spans : {};
  const spanList = (x: unknown): PanelId[] => (Array.isArray(x) ? x.filter(isPanel).filter((id) => id !== 'dispositivos') : []);
  const spanOf = (x: unknown): ZoneSpans => (isObject(x) ? { top: spanList(x.top), bottom: spanList(x.bottom) } : { top: [], bottom: [] });
  const spans = { left: spanOf(rawSpans.left), bottom: spanOf(rawSpans.bottom) };
  const closed: ClosedPanel[] = (Array.isArray(v.closed) ? v.closed : []).flatMap((c: unknown) => (isObject(c) && isPanel(c.id) && (c.zone === 'left' || c.zone === 'bottom') && num(c.index, 0, 50)
    ? [{ id: c.id, zone: c.zone as ZoneId, index: Math.round(c.index as number), row: num(c.row, 0, 50) ? Math.round(c.row as number) : null, ...(c.span === 'top' || c.span === 'bottom' ? { span: c.span as 'top' | 'bottom' } : {}) }]
    : []));
  const spanned = [spans.left, spans.bottom].flatMap((z) => [...z.top, ...z.bottom]);
  const all = [...left.flat(), ...bottom.flat(), ...spanned, ...closed.map((c) => c.id)];
  const unique = new Set(all);
  if (unique.size !== all.length) return { ...DEFAULT_LAYOUT };
  // "dispositivos" nunca divide espaço com outra área: fica sozinho no topo da coluna da esquerda (ou fechado).
  const devices = left.findIndex((c) => c.includes('dispositivos'));
  if (bottom.flat().includes('dispositivos') || (devices >= 0 && (devices !== 0 || left[0].length !== 1))) return { ...DEFAULT_LAYOUT };
  const nextLeft = [...left];
  for (const id of PANEL_IDS) if (!unique.has(id)) nextLeft.push([id]);
  const sizes = (list: unknown, n: number) => (Array.isArray(list) && list.length === n && list.every((x) => num(x, 0.03, 1)) ? (list as number[]) : null);
  const added = nextLeft.length !== left.length;
  const keys = new Map([...nextLeft, ...bottom].filter((c) => c.length > 1).map((c) => [c.join('+'), c.length]));
  const stackSizes: Record<string, number[]> = {};
  if (isObject(v.stackSizes)) {
    for (const [key, list] of Object.entries(v.stackSizes)) {
      const n = keys.get(key);
      const ok = n ? sizes(list, n) : null;
      if (ok) stackSizes[key] = ok;
    }
  }
  return {
    left: nextLeft,
    bottom,
    leftSizes: added ? null : sizes(v.leftSizes, nextLeft.filter((c) => c[0] !== 'dispositivos').length),
    devicesHeight: num(v.devicesHeight, 0.15, 0.9) ? (v.devicesHeight as number) : DEFAULT_LAYOUT.devicesHeight,
    bottomSizes: sizes(v.bottomSizes, bottom.length),
    leftWidth: num(v.leftWidth, 200, 2000) ? Math.round(v.leftWidth as number) : DEFAULT_LAYOUT.leftWidth,
    bottomHeight: num(v.bottomHeight, 120, 2000) ? Math.round(v.bottomHeight as number) : DEFAULT_LAYOUT.bottomHeight,
    stackSizes,
    closed,
    spans,
    spanSizes: Object.fromEntries((['left', 'bottom'] as const).flatMap((z) => {
      const rows = spans[z].top.length + spans[z].bottom.length + 1;
      const ok = rows > 1 && isObject(v.spanSizes) ? sizes(v.spanSizes[z], rows) : null;
      return ok ? [[z, ok]] : [];
    })),
  };
}

/** Indicadores do Programa (qualidade, pessoas online, comentários). */
export function hudOf(v: unknown): ProgramHud {
  return isObject(v) ? { quality: v.quality !== false, viewers: v.viewers !== false, chat: v.chat === true } : { ...DEFAULT_HUD };
}

function windowStateOf(v: unknown): WindowState | null {
  if (!isObject(v) || ![v.x, v.y].every((n) => num(n, -100000, 100000)) || !num(v.width, 200, 20000) || !num(v.height, 200, 20000)) return null;
  return { x: Math.round(v.x as number), y: Math.round(v.y as number), width: Math.round(v.width as number), height: Math.round(v.height as number), maximized: v.maximized === true, fullscreen: v.fullscreen === true };
}

/** Arquivo de layout salvo pelo Menu › Layout. Arquivo de outro tipo ou estragado = erro com explicação. */
export function layoutFile(v: unknown): LayoutFile {
  if (!isObject(v) || v.kind !== 'estudio-layout') throw new Error('Este arquivo não é um layout do Estúdio ao Vivo.');
  if (!isObject(v.layout) || !Array.isArray(v.layout.left) || !Array.isArray(v.layout.bottom)) throw new Error('O arquivo de layout está incompleto ou estragado.');
  return { kind: 'estudio-layout', version: 1, layout: layout(v.layout), hud: hudOf(v.hud), window: windowStateOf(v.window) };
}
