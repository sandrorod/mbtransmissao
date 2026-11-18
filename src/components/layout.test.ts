import { describe, expect, it } from 'vitest';
import { closePanel, movePanel, openPanel, resizeEqualized } from './Layout';
import { layout } from '../utils/validate';
import { DEFAULT_LAYOUT, type Layout } from '../types/studio';

const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

describe('resizeEqualized', () => {
  it('a área redimensionada fica com o tamanho pedido e as outras ficam iguais', () => {
    const sizes = resizeEqualized(4, 0, 0.4);
    expect(sizes[0]).toBeCloseTo(0.4);
    expect(sizes[1]).toBeCloseTo(0.2);
    expect(sizes[2]).toBeCloseTo(sizes[3]);
    expect(sum(sizes)).toBeCloseTo(1);
  });

  it('a divisória cai embaixo do ponteiro mesmo para uma área do meio', () => {
    const sizes = resizeEqualized(4, 1, 0.6);
    expect(sizes[0] + sizes[1]).toBeCloseTo(0.6);
    expect(sizes[0]).toBeCloseTo(sizes[2]);
    expect(sizes[2]).toBeCloseTo(sizes[3]);
  });

  it('nenhuma área some', () => {
    const sizes = resizeEqualized(4, 0, 0.99);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.079);
    expect(sum(sizes)).toBeCloseTo(1);
  });
});

describe('movePanel', () => {
  const zones = { left: DEFAULT_LAYOUT.left, bottom: DEFAULT_LAYOUT.bottom };
  const col = (zone: 'left' | 'bottom', index: number) => ({ kind: 'column' as const, zone, index });
  it('reordena dentro da mesma faixa (lado a lado)', () => {
    expect(movePanel(zones, 'selecao', col('bottom', 0))?.bottom).toEqual([['selecao'], ['previa'], ['cenas'], ['mixer']]);
    expect(movePanel(zones, 'previa', col('bottom', 2))?.bottom).toEqual([['cenas'], ['previa'], ['mixer'], ['selecao']]);
  });
  it('leva para a outra faixa', () => {
    const next = movePanel(zones, 'mixer', col('left', 1));
    expect(next?.left).toEqual([['dispositivos'], ['mixer'], ['widgets'], ['midias'], ['replay']]);
    expect(next?.bottom).toEqual([['previa'], ['cenas'], ['selecao']]);
  });
  it('empilha uma área embaixo (ou em cima) de outra', () => {
    const below = movePanel(zones, 'mixer', { kind: 'stack', anchor: 'cenas', below: true });
    expect(below?.bottom).toEqual([['previa'], ['cenas', 'mixer'], ['selecao']]);
    const above = movePanel(below!, 'selecao', { kind: 'stack', anchor: 'cenas', below: false });
    expect(above?.bottom).toEqual([['previa'], ['selecao', 'cenas', 'mixer']]);
    // Tirar da pilha para o lado.
    expect(movePanel(above!, 'cenas', col('bottom', 2))?.bottom).toEqual([['previa'], ['selecao', 'mixer'], ['cenas']]);
    // Empilhar entre faixas.
    expect(movePanel(zones, 'replay', { kind: 'stack', anchor: 'previa', below: true })?.bottom[0]).toEqual(['previa', 'replay']);
  });
  it('"dispositivos" fica sozinho no topo da esquerda; faixa pode ficar vazia', () => {
    expect(movePanel(zones, 'dispositivos', col('bottom', 0))).toBeNull();
    expect(movePanel(zones, 'cenas', { kind: 'stack', anchor: 'dispositivos', below: true })).toBeNull();
    expect(movePanel(zones, 'cenas', col('left', 0))?.left[1]).toEqual(['cenas']);
    expect(movePanel({ left: [['dispositivos'], ['widgets']], bottom: [['selecao']] }, 'selecao', col('left', 5))?.bottom).toEqual([]);
    expect(movePanel({ left: [['widgets']], bottom: [['cenas']] }, 'cenas', col('left', 0))?.left).toEqual([['cenas'], ['widgets']]);
  });
});

describe('fechar e reabrir áreas', () => {
  it('fecha e reabre no mesmo lugar', () => {
    const closed = closePanel(DEFAULT_LAYOUT, 'cenas');
    expect(closed.bottom).toEqual([['previa'], ['mixer'], ['selecao']]);
    expect(closed.closed).toEqual([{ id: 'cenas', zone: 'bottom', index: 1, row: null }]);
    const back = openPanel(closed, 'cenas');
    expect(back.bottom).toEqual(DEFAULT_LAYOUT.bottom);
    expect(back.closed).toEqual([]);
  });
  it('área empilhada volta para a mesma pilha', () => {
    const stacked: Layout = { ...DEFAULT_LAYOUT, bottom: [['previa'], ['cenas', 'mixer'], ['selecao']] };
    const closed = closePanel(stacked, 'mixer');
    expect(closed.bottom).toEqual([['previa'], ['cenas'], ['selecao']]);
    expect(openPanel(closed, 'mixer').bottom).toEqual(stacked.bottom);
  });
  it('as outras colunas mantêm a proporção', () => {
    const closed = closePanel({ ...DEFAULT_LAYOUT, bottomSizes: [0.4, 0.2, 0.2, 0.2] }, 'previa');
    expect(closed.bottomSizes).toEqual([1 / 3, 1 / 3, 1 / 3].map((x) => expect.closeTo(x)));
  });
  it('"dispositivos" volta sempre para o topo da esquerda', () => {
    const closed = closePanel(DEFAULT_LAYOUT, 'dispositivos');
    expect(closed.left).toEqual([['widgets'], ['midias'], ['replay']]);
    expect(openPanel(closed, 'dispositivos').left).toEqual(DEFAULT_LAYOUT.left);
  });
});

describe('layout (preferências)', () => {
  it('aceita a disposição salva e recusa área repetida ou "dispositivos" fora do lugar', () => {
    expect(layout({ ...DEFAULT_LAYOUT, bottomSizes: [0.4, 0.2, 0.2, 0.2] }).bottomSizes).toEqual([0.4, 0.2, 0.2, 0.2]);
    expect(layout({ ...DEFAULT_LAYOUT, left: [['dispositivos'], ['dispositivos']] })).toEqual(DEFAULT_LAYOUT);
    expect(layout({ ...DEFAULT_LAYOUT, left: [['dispositivos', 'widgets'], ['replay']] })).toEqual(DEFAULT_LAYOUT);
    expect(layout({ ...DEFAULT_LAYOUT, left: [['widgets'], ['replay']], bottom: [['dispositivos'], ['previa'], ['cenas'], ['mixer'], ['selecao']] })).toEqual(DEFAULT_LAYOUT);
    expect(layout(null)).toEqual(DEFAULT_LAYOUT);
  });
  it('formato antigo (lista simples) vira colunas; área nova entra na esquerda', () => {
    const old = layout({ left: ['dispositivos', 'widgets'], bottom: ['previa', 'cenas', 'mixer', 'selecao'], leftSizes: [1], devicesHeight: 0.6, leftWidth: 380, bottomHeight: 320 });
    expect(old.left).toEqual([['dispositivos'], ['widgets'], ['midias'], ['replay']]);
    expect(old.bottom).toEqual(DEFAULT_LAYOUT.bottom);
    expect(old.leftSizes).toBeNull();
  });
  it('pilhas e alturas das pilhas são guardadas', () => {
    const saved = layout({ ...DEFAULT_LAYOUT, bottom: [['previa'], ['cenas', 'mixer'], ['selecao']], bottomSizes: [0.3, 0.4, 0.3], stackSizes: { 'cenas+mixer': [0.7, 0.3], 'x+y': [0.5, 0.5] }, closed: [] });
    expect(saved.bottom[1]).toEqual(['cenas', 'mixer']);
    expect(saved.stackSizes).toEqual({ 'cenas+mixer': [0.7, 0.3] });
    const withClosed = layout({ ...DEFAULT_LAYOUT, bottom: [['previa'], ['mixer'], ['selecao']], closed: [{ id: 'cenas', zone: 'bottom', index: 1, row: null }] });
    expect(withClosed.closed).toEqual([{ id: 'cenas', zone: 'bottom', index: 1, row: null }]);
  });
});

describe('área na largura toda', () => {
  const zones = { left: DEFAULT_LAYOUT.left, bottom: DEFAULT_LAYOUT.bottom, spans: DEFAULT_LAYOUT.spans };
  it('uma área de duas lado a lado vai para baixo ocupando a largura das duas', () => {
    const next = movePanel(zones, 'replay', { kind: 'span', zone: 'left', side: 'bottom' })!;
    expect(next.left).toEqual([['dispositivos'], ['widgets'], ['midias']]);
    expect(next.spans.left.bottom).toEqual(['replay']);
    // E volta para o lado.
    const back = movePanel(next, 'replay', { kind: 'column', zone: 'left', index: 3 })!;
    expect(back.left).toEqual(DEFAULT_LAYOUT.left);
    expect(back.spans.left.bottom).toEqual([]);
  });
  it('acima das colunas, e outra área empilhada junto da que já está na largura toda', () => {
    const top = movePanel(zones, 'mixer', { kind: 'span', zone: 'bottom', side: 'top' })!;
    expect(top.spans.bottom.top).toEqual(['mixer']);
    expect(top.bottom).toEqual([['previa'], ['cenas'], ['selecao']]);
    const under = movePanel(top, 'selecao', { kind: 'stack', anchor: 'mixer', below: true })!;
    expect(under.spans.bottom.top).toEqual(['mixer', 'selecao']);
    expect(movePanel(top, 'dispositivos', { kind: 'span', zone: 'left', side: 'top' })).toBeNull();
  });
  it('fecha e reabre no mesmo lugar', () => {
    const next = { ...DEFAULT_LAYOUT, ...movePanel(zones, 'replay', { kind: 'span', zone: 'left', side: 'bottom' })! };
    const closed = closePanel(next, 'replay');
    expect(closed.spans.left.bottom).toEqual([]);
    expect(openPanel(closed, 'replay').spans.left.bottom).toEqual(['replay']);
  });
  it('é guardada nas preferências e não deixa área repetida', () => {
    const spans = { left: { top: [], bottom: ['replay'] }, bottom: { top: [], bottom: [] } };
    const saved = layout({ ...DEFAULT_LAYOUT, left: [['dispositivos'], ['widgets']], spans, spanSizes: { left: [0.6, 0.4] } });
    expect(saved.spans.left.bottom).toEqual(['replay']);
    expect(saved.spanSizes.left).toEqual([0.6, 0.4]);
    expect(layout({ ...DEFAULT_LAYOUT, spans })).toEqual(DEFAULT_LAYOUT);
  });
});
