import { describe, expect, it } from 'vitest';
import type { LiveStatus } from '../types/studio';
import { sameLiveCore } from './liveStore';

const base: LiveStatus = { state: 'ao-vivo', startedAt: 1, fps: 30, kbps: 6000, message: null, destinations: [{ id: 'y', name: 'YouTube', ok: true, error: null }] };

describe('status da live', () => {
  it('números (fps, Mbps, velocidade) sozinhos não redesenham a tela inteira', () => {
    expect(sameLiveCore(base, { ...base, fps: 12, kbps: 900, speed: 0.6 })).toBe(true);
  });
  it('estado, mensagem e destino que caiu redesenham', () => {
    expect(sameLiveCore(base, { ...base, state: 'reconectando' })).toBe(false);
    expect(sameLiveCore(base, { ...base, message: 'x' })).toBe(false);
    expect(sameLiveCore(base, { ...base, destinations: [{ id: 'y', name: 'YouTube', ok: false, error: 'caiu' }] })).toBe(false);
  });
});
