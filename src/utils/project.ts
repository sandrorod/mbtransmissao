import { baseName, displayName, findDevice, isAliasDevice, kindOf, type SystemDevice } from '../devices/identify';
import { DEFAULT_AUDIO, DEFAULT_VIDEO, ROLES, type DeviceKind, type DeviceRef, type Preferences, type Project, type Role, type Source } from '../types/studio';

export const newId = () => crypto.randomUUID();

/** Celulares e páginas não são aparelhos do Mac: aparecem e somem sozinhos, sem pedir substituto. */
export const isVirtualDevice = (deviceId: string) => deviceId.startsWith('celular:') || deviceId.startsWith('pagina:') || deviceId.startsWith('midia:');

/** Tira uma fonte de todas as cenas e da lista de fontes. */
export function removeSource(project: Project, sourceId: string): Project {
  return {
    ...project,
    sources: project.sources.filter((s) => s.id !== sourceId),
    scenes: project.scenes.map((sc) => ({ ...sc, items: sc.items.filter((i) => i.sourceId !== sourceId) })),
  };
}

/** Tira das cenas tudo o que usa um aparelho (ao remover o aparelho da lista). */
export function removeDeviceSources(project: Project, deviceId: string, label: string): Project {
  let next = project;
  for (const s of project.sources) {
    if (s.device.deviceId === deviceId || (label && s.device.label === label)) next = removeSource(next, s.id);
  }
  return next;
}

export const refOf = (device: SystemDevice): DeviceRef => ({ deviceId: device.deviceId, label: device.label });

export const realDevices = (devices: SystemDevice[], kind: SystemDevice['kind']) => devices.filter((d) => d.kind === kind && !isAliasDevice(d.deviceId));

/** Projeto novo com as cenas do dia a dia e os dispositivos preferidos (ou os primeiros encontrados). */
export function createProject(devices: SystemDevice[], prefs: Preferences): Project {
  const pick = (ref: DeviceRef | null, kind: SystemDevice['kind'], index = 0) => {
    const found = ref ? findDevice(ref, devices, kind) : null;
    const device = found ?? realDevices(devices, kind)[index] ?? null;
    return device ? refOf(device) : undefined;
  };
  const camera = pick(prefs.camera, 'videoinput');
  const microphone = pick(prefs.audioInterface ?? prefs.microphone, 'audioinput');
  const roles: Project['roles'] = {};
  if (camera) roles.camera = camera;
  if (microphone) roles.microphone = microphone;
  const project: Project = {
    version: 1,
    name: 'Nova transmissão',
    sources: [],
    scenes: [
      { id: newId(), name: 'JOGO', items: [] },
      { id: newId(), name: 'ENTREVISTA', items: [] },
      { id: newId(), name: 'INTERVALO', items: [] },
    ],
    activeSceneId: null,
    roles,
    monitorOutput: prefs.monitorOutput,
    pages: [],
  };
  project.activeSceneId = project.scenes[0].id;
  let result = project;
  if (camera) result = addToScene(result, project.scenes[0].id, 'video', camera, devices);
  if (microphone) result = addToScene(result, project.scenes[0].id, 'audio', microphone, devices);
  return result;
}

/** A fonte de um dispositivo: cada aparelho tem uma só, reaproveitada em todas as cenas. */
export function findSource(project: Project, kind: DeviceKind, ref: DeviceRef, devices: SystemDevice[]): Source | undefined {
  const exact = project.sources.find((s) => s.kind === kind && s.device.deviceId === ref.deviceId);
  if (exact) return exact;
  const device = findDevice(ref, devices, kindOf(kind));
  return project.sources.find((s) => s.kind === kind && device && findDevice(s.device, [device], kindOf(kind)));
}

export function ensureSource(project: Project, kind: DeviceKind, ref: DeviceRef, devices: SystemDevice[]): { project: Project; source: Source } {
  const existing = findSource(project, kind, ref, devices);
  if (existing) return { project, source: existing };
  const source: Source = kind === 'video'
    ? { id: newId(), kind, name: baseName(ref.label) || 'Câmera', device: ref, video: { ...DEFAULT_VIDEO, extra: {} } }
    : { id: newId(), kind, name: baseName(ref.label) || 'Microfone', device: ref, audio: { ...DEFAULT_AUDIO } };
  return { project: { ...project, sources: [...project.sources, source] }, source };
}

/** Coloca a fonte do dispositivo na cena (sem duplicar). */
/** O dispositivo já está na cena (como fonte do mesmo tipo)? Serve para não duplicar ao arrastar para a cena. */
export function sceneHasDevice(project: Project, sceneId: string, kind: DeviceKind, ref: DeviceRef, devices: SystemDevice[]): boolean {
  const source = findSource(project, kind, ref, devices);
  const scene = project.scenes.find((s) => s.id === sceneId);
  return Boolean(source && scene?.items.some((i) => i.sourceId === source.id));
}

export function addToScene(project: Project, sceneId: string, kind: DeviceKind, ref: DeviceRef, devices: SystemDevice[]): Project {
  const { project: next, source } = ensureSource(project, kind, ref, devices);
  const isWidget = (id: string) => next.sources.find((x) => x.id === id)?.device.deviceId.startsWith('pagina:') ?? false;
  // Widget e mídia (foto/vídeo) entram por cima de todas as camadas.
  const onTop = source.device.deviceId.startsWith('pagina:') || source.device.deviceId.startsWith('midia:');
  // O que foi ajustado na Prévia (posição, tamanho, corte, tela cheia) vai junto para o Programa.
  const staged = source.staged;
  return {
    ...next,
    scenes: next.scenes.map((s) => {
      if (s.id !== sceneId) return s;
      const existing = s.items.find((i) => i.sourceId === source.id);
      if (existing) {
        if (!staged) return s;
        return { ...s, items: s.items.map((i) => (i.sourceId === source.id ? { ...i, transform: staged.transform, fill: staged.fill, border: staged.border ?? null } : i)) };
      }
      const item = { sourceId: source.id, transform: staged?.transform ?? null, hidden: false, ...(staged?.fill ? { fill: staged.fill } : {}), ...(staged?.border ? { border: staged.border } : {}) };
      // Widget e mídia entram na frente de tudo; câmera/celular entra por cima das outras câmeras mas embaixo de todos os widgets.
      if (onTop) return { ...s, items: [...s.items, item] };
      const firstWidget = s.items.findIndex((i) => isWidget(i.sourceId));
      const at = firstWidget < 0 ? s.items.length : firstWidget;
      return { ...s, items: [...s.items.slice(0, at), item, ...s.items.slice(at)] };
    }),
  };
}

const isWidgetOrMedia = (deviceId: string) => deviceId.startsWith('pagina:') || deviceId.startsWith('midia:');

/**
 * Manda dispositivos para o Programa (cena no ar). Dispositivo comum TROCA quem estava no ar: as outras câmeras e
 * celulares saem da cena (widgets, mídias e dispositivos de sobreposição ficam). O que entra fica no lugar e no
 * tamanho de quem saiu (a não ser que venha ajustado da Prévia). Dispositivo de sobreposição só entra por cima.
 * Celular que sai leva junto o microfone dele (que tinha entrado automaticamente com a câmera).
 */
export function putOnProgram(project: Project, sceneId: string, refs: DeviceRef[], devices: SystemDevice[], isOverlay: (ref: DeviceRef) => boolean): Project {
  let next = project;
  const before = project.scenes.find((s) => s.id === sceneId);
  if (!before) return project;
  const wasIn = new Set(before.items.map((i) => i.sourceId));
  for (const ref of refs) next = addToScene(next, sceneId, 'video', ref, devices);
  const main = refs.filter((r) => !isOverlay(r) && !isWidgetOrMedia(r.deviceId));
  if (main.length === 0) return next;
  const keep = new Set(refs.map((r) => findSource(next, 'video', r, devices)?.id).filter((id): id is string => Boolean(id)));
  const scene = next.scenes.find((s) => s.id === sceneId)!;
  const sourceOf = (id: string) => next.sources.find((x) => x.id === id);
  const leaving = scene.items.filter((i) => {
    const src = sourceOf(i.sourceId);
    return src && src.kind === 'video' && !keep.has(src.id) && !isWidgetOrMedia(src.device.deviceId) && !isOverlay(src.device);
  });
  if (leaving.length === 0) return next;
  const out = new Set(leaving.map((i) => i.sourceId));
  // Microfone do celular que saiu.
  for (const item of leaving) {
    const id = sourceOf(item.sourceId)?.device.deviceId ?? '';
    if (!id.startsWith('celular:')) continue;
    const mic = id.replace(/:video$/, ':audio');
    for (const i of scene.items) if (sourceOf(i.sourceId)?.device.deviceId === mic) out.add(i.sourceId);
  }
  // O novo dispositivo principal herda o lugar (camada, posição, tamanho, borda) de quem estava no ar.
  const first = leaving[0];
  const mainSource = findSource(next, 'video', main[0], devices);
  const inherit = mainSource && !wasIn.has(mainSource.id) && !mainSource.staged ? mainSource.id : null;
  const items = scene.items.flatMap((i) => {
    if (i.sourceId === inherit) return [];
    if (i === first && inherit) {
      const old = scene.items.find((x) => x.sourceId === inherit)!;
      return [{ ...old, transform: first.transform, ...(first.fill ? { fill: first.fill } : {}), ...(first.border ? { border: first.border } : {}) }];
    }
    return out.has(i.sourceId) ? [] : [i];
  });
  return { ...next, scenes: next.scenes.map((s) => (s.id === sceneId ? { ...s, items } : s)) };
}

export interface MissingItem {
  /** "source:<id>", "role:<role>" ou "monitor". */
  id: string;
  what: string;
  kind: SystemDevice['kind'];
  ref: DeviceRef;
}

/** O que o projeto usa e não está conectado agora. */
export function missingDevices(project: Project, devices: SystemDevice[]): MissingItem[] {
  const items: MissingItem[] = [];
  for (const source of project.sources) {
    if (!findDevice(source.device, devices, kindOf(source.kind))) {
      if (isVirtualDevice(source.device.deviceId)) continue;
      const scenes = project.scenes.filter((s) => s.items.some((i) => i.sourceId === source.id)).map((s) => s.name);
      items.push({ id: `source:${source.id}`, what: `Fonte ${source.name}${scenes.length ? ` (${scenes.join(', ')})` : ''}`, kind: kindOf(source.kind), ref: source.device });
    }
  }
  for (const role of Object.keys(project.roles) as Role[]) {
    const ref = project.roles[role]!;
    const kind = kindOf(ROLES[role].kind);
    if (!findDevice(ref, devices, kind)) items.push({ id: `role:${role}`, what: ROLES[role].label, kind, ref });
  }
  if (project.monitorOutput && !findDevice(project.monitorOutput, devices, 'audiooutput')) {
    items.push({ id: 'monitor', what: 'Monitoramento', kind: 'audiooutput', ref: project.monitorOutput });
  }
  return items;
}

/** Troca o dispositivo de um item (fonte, papel ou monitoramento) mantendo as configurações. */
export function replaceDevice(project: Project, itemId: string, ref: DeviceRef): Project {
  if (itemId.startsWith('source:')) {
    const id = itemId.slice(7);
    return {
      ...project,
      sources: project.sources.map((s) => {
        if (s.id !== id) return s;
        // Outro aparelho pode não ter o mesmo modo: volta para "automático" e mantém o resto.
        const video = s.video ? { ...s.video, width: 0, height: 0, fps: 0 } : undefined;
        const audio = s.audio ? { ...s.audio, channel: 'all' as const, sampleRate: 0 } : undefined;
        const renamed = s.name === s.device.label || s.name === baseName(s.device.label) || s.name === displayName(s.device.label) ? baseName(ref.label) : s.name;
        return { ...s, device: ref, name: renamed, ...(video ? { video } : {}), ...(audio ? { audio } : {}) };
      }),
    };
  }
  if (itemId.startsWith('role:')) {
    const role = itemId.slice(5) as Role;
    return { ...project, roles: { ...project.roles, [role]: ref } };
  }
  if (itemId === 'monitor') return { ...project, monitorOutput: ref };
  return project;
}

/** Depois de religar com outro id: atualiza tudo o que apontava para o aparelho antigo. */
export function updateDeviceIds(project: Project, oldId: string, device: SystemDevice): Project {
  const fix = (ref: DeviceRef): DeviceRef => (ref.deviceId === oldId ? refOf(device) : ref);
  const roles = Object.fromEntries(Object.entries(project.roles).map(([role, ref]) => [role, fix(ref!)])) as Project['roles'];
  return {
    ...project,
    sources: project.sources.map((s) => (s.device.deviceId === oldId ? { ...s, device: refOf(device) } : s)),
    roles,
    monitorOutput: project.monitorOutput ? fix(project.monitorOutput) : null,
  };
}
