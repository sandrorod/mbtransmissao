import { describe, expect, it } from 'vitest';
import { transitionFrame } from './replay';

const a = { id: 'a' } as unknown as HTMLVideoElement;
const b = { id: 'b' } as unknown as HTMLVideoElement;

describe('transições do replay', () => {
  it('fusão: o próximo aparece por cima do atual', () => {
    expect(transitionFrame('fade', 'cross', 0.25, a, b)).toEqual({ layers: [{ video: a, alpha: 1, x: 0 }, { video: b, alpha: 0.25, x: 0 }], black: 0 });
    expect(transitionFrame('fade', 'in', 0.5, a, null).layers[0].alpha).toBe(0.5);
    expect(transitionFrame('fade', 'out', 1, a, null).layers[0].alpha).toBe(0);
  });
  it('preto: escurece até a metade e clareia já no próximo', () => {
    expect(transitionFrame('preto', 'cross', 0.25, a, b)).toEqual({ layers: [{ video: a, alpha: 1, x: 0 }], black: 0.5 });
    expect(transitionFrame('preto', 'cross', 0.75, a, b)).toEqual({ layers: [{ video: b, alpha: 1, x: 0 }], black: 0.5 });
  });
  it('deslizar: os dois andam juntos para a esquerda', () => {
    const f = transitionFrame('deslizar', 'cross', 0.5, a, b);
    expect(f.layers.map((l) => l.x)).toEqual([-0.5, 0.5]);
  });
  it('corte seco: só o atual', () => {
    expect(transitionFrame('corte', 'cross', 0.5, a, b)).toEqual({ layers: [{ video: a, alpha: 1, x: 0 }], black: 0 });
  });
});
