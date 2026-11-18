import { useSyncExternalStore } from 'react';
import type { LiveStatus } from '../types/studio';

/**
 * Números da transmissão que mudam a toda hora (Mbps, quadros/s, velocidade). Ficam fora do estado do App:
 * antes cada atualização (2×/s) mais o relógio (1×/s) redesenhavam a tela inteira durante a live, roubando
 * o processador do desenho do programa. Agora só o selo "AO VIVO" e o indicador de conexão se redesenham.
 */
let current: LiveStatus | null = null;
const listeners = new Set<() => void>();

export const liveStore = {
  set(status: LiveStatus): void {
    current = status;
    for (const listener of listeners) listener();
  },
  get: (): LiveStatus | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const useLiveMetrics = (): LiveStatus | null => useSyncExternalStore(liveStore.subscribe, liveStore.get);

/** O que muda o resto da tela (estado, mensagens, destinos). Números sozinhos não contam. */
export function sameLiveCore(a: LiveStatus, b: LiveStatus): boolean {
  return a.state === b.state && a.message === b.message && a.startedAt === b.startedAt
    && a.destinations.length === b.destinations.length
    && a.destinations.every((d, i) => d.id === b.destinations[i].id && d.ok === b.destinations[i].ok && d.error === b.destinations[i].error);
}
