import type { Scene, SceneFolder, SceneItem } from '../types/studio';

/**
 * Pastas das fontes do programa. As fontes de uma pasta ficam sempre juntas na ordem das camadas,
 * então a lista continua mostrando quem aparece na frente (em cima) e atrás (embaixo).
 */

export type FolderRow = { kind: 'folder'; folder: SceneFolder; items: SceneItem[] };
export type ItemRow = { kind: 'item'; item: SceneItem };
export type Row = FolderRow | ItemRow;

/** Onde soltar: antes/depois de uma fonte ou de uma pasta (na lista, de cima para baixo), ou dentro de uma pasta. */
export type DropTarget =
  | { kind: 'item'; id: string; after: boolean }
  | { kind: 'folder'; id: string; zone: 'before' | 'after' | 'inside' };

const folderOf = (item: SceneItem, folders: SceneFolder[]) => (item.folder && folders.some((f) => f.id === item.folder) ? item.folder : null);

/** Junta as fontes de cada pasta num bloco só (no lugar da fonte da pasta que está mais à frente). */
export function groupItems(items: SceneItem[], folders: SceneFolder[] = []): SceneItem[] {
  const front = [...items].reverse();
  const out: SceneItem[] = [];
  const done = new Set<string>();
  for (const item of front) {
    const f = folderOf(item, folders);
    if (!f) out.push({ ...item, folder: null });
    else if (!done.has(f)) {
      done.add(f);
      out.push(...front.filter((x) => folderOf(x, folders) === f));
    }
  }
  return out.reverse();
}

/** Linhas da lista, de cima (frente) para baixo (atrás). Pastas vazias ficam no topo. */
export function rows(scene: Scene): Row[] {
  const folders = scene.folders ?? [];
  const front = [...groupItems(scene.items, folders)].reverse();
  const out: Row[] = [];
  const used = new Set<string>();
  for (const item of front) {
    const f = folderOf(item, folders);
    if (!f) out.push({ kind: 'item', item });
    else if (!used.has(f)) {
      used.add(f);
      out.push({ kind: 'folder', folder: folders.find((x) => x.id === f)!, items: front.filter((x) => folderOf(x, folders) === f) });
    }
  }
  const empty: Row[] = folders.filter((f) => !used.has(f.id)).map((folder) => ({ kind: 'folder', folder, items: [] }));
  return [...empty, ...out];
}

/** Lista de cima para baixo → camadas (de trás para a frente), já agrupadas. */
const toItems = (front: SceneItem[], folders: SceneFolder[]) => groupItems([...front].reverse(), folders);

/** Move uma fonte para antes/depois de outra (entra na pasta dela) ou para dentro de uma pasta (no topo). */
export function moveItem(scene: Scene, sourceId: string, target: DropTarget): SceneItem[] {
  const folders = scene.folders ?? [];
  const front = [...groupItems(scene.items, folders)].reverse();
  const moved = front.find((i) => i.sourceId === sourceId);
  if (!moved) return scene.items;
  const rest = front.filter((i) => i.sourceId !== sourceId);
  if (target.kind === 'item') {
    if (target.id === sourceId) return scene.items;
    const at = rest.findIndex((i) => i.sourceId === target.id);
    if (at < 0) return scene.items;
    const into = folderOf(rest[at], folders);
    rest.splice(at + (target.after ? 1 : 0), 0, { ...moved, folder: into });
    return toItems(rest, folders);
  }
  const members = rest.map((x, i) => (folderOf(x, folders) === target.id ? i : -1)).filter((i) => i >= 0);
  if (target.zone === 'inside') {
    // Entra no topo da pasta (frente); pasta vazia: vai para o topo da lista.
    rest.splice(members.length ? members[0] : 0, 0, { ...moved, folder: target.id });
    return toItems(rest, folders);
  }
  // Antes/depois da pasta: fica fora dela, logo acima ou abaixo do bloco.
  const index = members.length ? (target.zone === 'before' ? members[0] : members[members.length - 1] + 1) : 0;
  rest.splice(index, 0, { ...moved, folder: null });
  return toItems(rest, folders);
}

/** Move a pasta inteira (o bloco de fontes) para antes/depois de uma fonte ou de outra pasta. */
export function moveFolder(scene: Scene, folderId: string, target: DropTarget): { items: SceneItem[]; folders: SceneFolder[] } {
  const folders = scene.folders ?? [];
  const front = [...groupItems(scene.items, folders)].reverse();
  const block = front.filter((i) => folderOf(i, folders) === folderId);
  const rest = front.filter((i) => folderOf(i, folders) !== folderId);
  let index = 0;
  let after = false;
  if (target.kind === 'item') {
    const at = rest.findIndex((i) => i.sourceId === target.id);
    const inFolder = at >= 0 ? folderOf(rest[at], folders) : null;
    if (inFolder) return moveFolder(scene, folderId, { kind: 'folder', id: inFolder, zone: target.after ? 'after' : 'before' });
    index = at < 0 ? 0 : at;
    after = target.after;
  } else {
    if (target.id === folderId) return { items: scene.items, folders };
    const members = rest.map((x, i) => (folderOf(x, folders) === target.id ? i : -1)).filter((i) => i >= 0);
    after = target.zone !== 'before';
    index = members.length ? (after ? members[members.length - 1] : members[0]) : 0;
  }
  rest.splice(index + (after && rest.length ? 1 : 0), 0, ...block);
  // Pastas vazias guardam a ordem entre si pela lista de pastas.
  const order = folders.filter((f) => f.id !== folderId);
  const targetFolder = target.kind === 'folder' ? order.findIndex((f) => f.id === target.id) : -1;
  const moved = folders.find((f) => f.id === folderId);
  if (moved) order.splice(targetFolder < 0 ? order.length : targetFolder + (after ? 1 : 0), 0, moved);
  return { items: toItems(rest, folders), folders: order };
}

/** Apaga a pasta; as fontes continuam na cena, no mesmo lugar, fora de pasta. */
export function removeFolder(scene: Scene, folderId: string): { items: SceneItem[]; folders: SceneFolder[] } {
  return { items: scene.items.map((i) => (i.folder === folderId ? { ...i, folder: null } : i)), folders: (scene.folders ?? []).filter((f) => f.id !== folderId) };
}

/*
 * Pastas da lista de widgets: mesma lógica das pastas das cenas. A lista de widgets vai de cima para baixo,
 * então ela vira uma "cena" invertida (o primeiro widget fica na frente) e volta ao final.
 */
type Foldered = { id: string; folder?: string | null };

const asScene = <T extends Foldered>(pages: T[], folders: SceneFolder[]): Scene => ({
  id: 'widgets',
  name: '',
  items: [...pages].reverse().map((p) => ({ sourceId: p.id, transform: null, hidden: false, folder: p.folder ?? null })),
  folders,
});

const fromItems = <T extends Foldered>(pages: T[], items: SceneItem[]): T[] =>
  [...items].reverse().flatMap((i) => {
    const page = pages.find((p) => p.id === i.sourceId);
    return page ? [{ ...page, folder: i.folder ?? null }] : [];
  });

export type WidgetRow<T> = { kind: 'folder'; folder: SceneFolder; pages: T[] } | { kind: 'page'; page: T };

export function widgetRows<T extends Foldered>(pages: T[], folders: SceneFolder[]): WidgetRow<T>[] {
  return rows(asScene(pages, folders)).map((r) => (r.kind === 'item'
    ? { kind: 'page' as const, page: pages.find((p) => p.id === r.item.sourceId)! }
    : { kind: 'folder' as const, folder: r.folder, pages: r.items.map((i) => pages.find((p) => p.id === i.sourceId)!) }));
}

export function moveWidget<T extends Foldered>(pages: T[], folders: SceneFolder[], pageId: string, target: DropTarget): T[] {
  return fromItems(pages, moveItem(asScene(pages, folders), pageId, target));
}

export function moveWidgetFolder<T extends Foldered>(pages: T[], folders: SceneFolder[], folderId: string, target: DropTarget): { pages: T[]; folders: SceneFolder[] } {
  const next = moveFolder(asScene(pages, folders), folderId, target);
  return { pages: fromItems(pages, next.items), folders: next.folders };
}

export function removeWidgetFolder<T extends Foldered>(pages: T[], folders: SceneFolder[], folderId: string): { pages: T[]; folders: SceneFolder[] } {
  return { pages: pages.map((p) => (p.folder === folderId ? { ...p, folder: null } : p)), folders: folders.filter((f) => f.id !== folderId) };
}
