import { describe, expect, it } from 'vitest';
import type { Scene } from '../types/studio';
import { groupItems, moveFolder, moveItem, moveWidget, removeFolder, removeWidgetFolder, rows, widgetRows } from './folders';

const item = (id: string, folder: string | null = null) => ({ sourceId: id, transform: null, hidden: false, folder });
// Camadas de trás para a frente: a, b, c, d (na lista: d, c, b, a).
const scene = (items = [item('a'), item('b'), item('c'), item('d')]): Scene => ({ id: 's', name: 'S', items, folders: [{ id: 'f', name: 'Placar', collapsed: false }] });
const order = (items: { sourceId: string }[]) => items.map((i) => i.sourceId).join('');

describe('pastas das fontes', () => {
  it('pasta vazia aparece no topo da lista', () => {
    expect(rows(scene())[0]).toMatchObject({ kind: 'folder', items: [] });
  });
  it('soltar dentro da pasta vazia: entra nela e vai para a frente', () => {
    const items = moveItem(scene(), 'a', { kind: 'folder', id: 'f', zone: 'inside' });
    expect(order(items)).toBe('bcda');
    expect(items.find((i) => i.sourceId === 'a')?.folder).toBe('f');
  });
  it('fontes da pasta ficam juntas nas camadas', () => {
    const s = scene([item('a', 'f'), item('b'), item('c', 'f'), item('d')]);
    expect(order(groupItems(s.items, s.folders))).toBe('bacd');
    const r = rows(s);
    expect(r.map((x) => (x.kind === 'folder' ? `[${x.items.map((i) => i.sourceId).join('')}]` : x.item.sourceId)).join('')).toBe('d[ca]b');
  });
  it('soltar ao lado de uma fonte da pasta: entra na pasta', () => {
    const s = scene([item('a', 'f'), item('b'), item('c'), item('d')]);
    const items = moveItem(s, 'd', { kind: 'item', id: 'a', after: false });
    expect(items.find((i) => i.sourceId === 'd')?.folder).toBe('f');
    // Lista: c b [d a] → camadas: a d b c.
    expect(order(items)).toBe('adbc');
    expect(rows({ ...s, items }).at(-1)).toMatchObject({ kind: 'folder', items: [{ sourceId: 'd' }, { sourceId: 'a' }] });
  });
  it('soltar ao lado de uma fonte fora: sai da pasta', () => {
    const s = scene([item('a', 'f'), item('b'), item('c'), item('d')]);
    const items = moveItem(s, 'a', { kind: 'item', id: 'd', after: false });
    expect(items.find((i) => i.sourceId === 'a')?.folder).toBeNull();
    expect(order(items)).toBe('bcda');
  });
  it('mover a pasta leva o bloco inteiro', () => {
    const s = scene([item('a', 'f'), item('b', 'f'), item('c'), item('d')]);
    const { items } = moveFolder(s, 'f', { kind: 'item', id: 'd', after: false });
    // Lista: [b a] d c → camadas (trás→frente): c d a b.
    expect(order(items)).toBe('cdab');
  });
  it('apagar a pasta mantém as fontes no lugar', () => {
    const s = scene([item('a', 'f'), item('b', 'f'), item('c'), item('d')]);
    const r = removeFolder(s, 'f');
    expect(order(r.items)).toBe('abcd');
    expect(r.items.every((i) => !i.folder)).toBe(true);
    expect(r.folders).toHaveLength(0);
  });
});

describe('pastas dos widgets', () => {
  const pages: { id: string; folder?: string | null }[] = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  const folders = [{ id: 'w', name: 'Placares', collapsed: false }];
  const ids = (list: { id: string }[]) => list.map((p) => p.id).join(',');
  it('lista na ordem dos widgets, pasta vazia no topo', () => {
    const r = widgetRows(pages, folders);
    expect(r[0]).toMatchObject({ kind: 'folder', pages: [] });
    expect(r.slice(1).map((x) => (x.kind === 'page' ? x.page.id : ''))).toEqual(['p1', 'p2', 'p3']);
  });
  it('arrastar para dentro da pasta e mudar de ordem', () => {
    const inside = moveWidget(pages, folders, 'p3', { kind: 'folder', id: 'w', zone: 'inside' });
    expect(inside.find((p) => p.id === 'p3')?.folder).toBe('w');
    const r = widgetRows(inside, folders);
    expect(r[0]).toMatchObject({ kind: 'folder', pages: [{ id: 'p3' }] });
    expect(ids(moveWidget(pages, [], 'p1', { kind: 'item', id: 'p3', after: true }))).toBe('p2,p3,p1');
  });
  it('apagar a pasta mantém os widgets', () => {
    const inside = moveWidget(pages, folders, 'p2', { kind: 'folder', id: 'w', zone: 'inside' });
    const out = removeWidgetFolder(inside, folders, 'w');
    expect(out.folders).toEqual([]);
    expect(out.pages.every((p) => !p.folder)).toBe(true);
    expect(out.pages).toHaveLength(3);
  });
});
