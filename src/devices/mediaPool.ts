import type { DeviceKind } from '../types/studio';
import { findDevice, kindOf, type SystemDevice } from './identify';

export type StreamStatus = 'abrindo' | 'ativo' | 'desconectado' | 'falhou';

/** O que abrir: dispositivo + restrições de captura (sem o deviceId, que o pool coloca). */
export interface StreamSpec {
  kind: DeviceKind;
  deviceId: string;
  label: string;
  constraints: MediaTrackConstraints;
}

export interface PoolEntry {
  key: string;
  spec: StreamSpec;
  stream: MediaStream | null;
  status: StreamStatus;
  error: string | null;
  refs: number;
  /** Cada abertura ganha um número; respostas de aberturas antigas são descartadas. */
  attempt: number;
}

export interface PoolEvents {
  /** Uma fonte em uso perdeu o dispositivo (desconectado ou falhou durante a captura). */
  lost?: (entry: PoolEntry) => void;
  /** O dispositivo voltou e a captura foi reaberta; deviceId pode ter mudado. */
  recovered?: (entry: PoolEntry, device: SystemDevice, previousId: string) => void;
  /**
   * Fontes que não são aparelhos do sistema (páginas de widget): a lista do sistema nunca as derruba.
   * Sem isso, um widget ainda não salvo era dado como "desconectado" e a imagem congelava no 1º quadro.
   */
  managed?: (spec: StreamSpec) => boolean;
}

type Opener = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export const specKey = (spec: StreamSpec) => `${spec.kind}|${spec.deviceId}|${JSON.stringify(spec.constraints)}`;

const NOT_FOUND = ['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError'];

function describe(error: unknown): { gone: boolean; message: string } {
  const name = error instanceof Error || (typeof error === 'object' && error && 'name' in error) ? String((error as { name: string }).name) : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError') return { gone: false, message: 'Sem permissão do macOS para usar este dispositivo.' };
  // O id pedido não existe mais (o Chromium dá ids diferentes por perfil/origem): é tratado como desconectado,
  // e a próxima lista do sistema reencontra o dispositivo pelo nome.
  if (name === 'OverconstrainedError' && (error as { constraint?: string }).constraint === 'deviceId') return { gone: true, message: 'Procurando o dispositivo pelo nome…' };
  if (name === 'OverconstrainedError') return { gone: false, message: 'O dispositivo não aceita essa configuração de captura.' };
  if (name === 'NotReadableError') return { gone: false, message: 'O dispositivo está ocupado ou travado por outro aplicativo.' };
  return { gone: NOT_FOUND.includes(name), message: message || 'Não foi possível abrir o dispositivo.' };
}

/**
 * Abre cada dispositivo uma única vez por configuração, não importa em quantas cenas ou prévias ele aparece.
 * A perda de um dispositivo só afeta as fontes dele: nada mais é fechado.
 */
export class MediaPool {
  private entries = new Map<string, PoolEntry>();
  private listeners = new Set<() => void>();
  private pendingRelease = new Map<string, ReturnType<typeof setTimeout>>();
  /** Muda a cada alteração; usado pelo React para redesenhar. */
  version = 0;
  /** Quantas vezes um dispositivo foi realmente aberto (diagnóstico e testes). */
  opens = 0;

  constructor(private open: Opener, private events: PoolEvents = {}, private releaseDelayMs = 400) {}

  /** Soma (não substitui) as regras: a de páginas, definida na criação do pool, não pode se perder. */
  setEvents(events: PoolEvents): void {
    this.events = { ...this.events, ...events };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  get(key: string): PoolEntry | undefined {
    return this.entries.get(key);
  }

  list(): PoolEntry[] {
    return [...this.entries.values()];
  }

  acquire(spec: StreamSpec): string {
    const key = specKey(spec);
    const timer = this.pendingRelease.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingRelease.delete(key);
    }
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, spec, stream: null, status: 'abrindo', error: null, refs: 0, attempt: 0 };
      this.entries.set(key, entry);
      void this.start(entry);
    }
    entry.refs++;
    return key;
  }

  /** Solta uma referência; o dispositivo só fecha quando ninguém mais usa (com uma folga contra abre/fecha). */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    const close = () => {
      this.pendingRelease.delete(key);
      if (entry.refs > 0 || this.entries.get(key) !== entry) return;
      this.stop(entry);
      this.entries.delete(key);
      this.emit();
    };
    if (this.releaseDelayMs <= 0) close();
    else this.pendingRelease.set(key, setTimeout(close, this.releaseDelayMs));
  }

  retry(key: string): void {
    const entry = this.entries.get(key);
    if (entry) void this.start(entry);
  }

  private stop(entry: PoolEntry): void {
    entry.stream?.getTracks().forEach((t) => t.stop());
    entry.stream = null;
  }

  private async start(entry: PoolEntry): Promise<void> {
    const attempt = ++entry.attempt;
    this.stop(entry);
    entry.status = 'abrindo';
    entry.error = null;
    this.emit();
    const { kind, deviceId, constraints } = entry.spec;
    const track: MediaTrackConstraints = { ...constraints, deviceId: { exact: deviceId } };
    try {
      this.opens++;
      const stream = await this.open(kind === 'video' ? { video: track, audio: false } : { audio: track, video: false });
      if (attempt !== entry.attempt || this.entries.get(entry.key) !== entry) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      entry.stream = stream;
      entry.status = 'ativo';
      for (const t of stream.getTracks()) {
        t.addEventListener('ended', () => {
          if (attempt === entry.attempt && entry.status === 'ativo') this.lose(entry, 'O dispositivo parou de enviar sinal.');
        });
      }
      this.emit();
    } catch (error) {
      if (attempt !== entry.attempt) return;
      const { gone, message } = describe(error);
      entry.status = gone ? 'desconectado' : 'falhou';
      entry.error = message;
      this.emit();
    }
  }

  private lose(entry: PoolEntry, message: string): void {
    this.stop(entry);
    entry.attempt++;
    entry.status = 'desconectado';
    entry.error = message;
    this.emit();
    this.events.lost?.(entry);
  }

  /**
   * Recebe a lista atual do sistema: derruba as fontes cujo dispositivo sumiu e reabre as que voltaram,
   * mesmo que o macOS tenha dado um novo id (reencontra pelo nome).
   */
  sync(devices: SystemDevice[]): void {
    for (const entry of this.entries.values()) {
      if (this.events.managed?.(entry.spec)) {
        // Página que caiu (a janela dela recarregou ou travou): reabre a captura, sem depender da lista do sistema.
        if (entry.status === 'desconectado') void this.start(entry);
        continue;
      }
      const found = findDevice({ deviceId: entry.spec.deviceId, label: entry.spec.label }, devices, kindOf(entry.spec.kind));
      if (!found) {
        if (entry.status === 'ativo' || entry.status === 'abrindo') this.lose(entry, 'Dispositivo desconectado.');
        continue;
      }
      // Também reabre uma fonte que falhou se o mesmo dispositivo aparece com outro id.
      if (entry.status === 'desconectado' || (entry.status === 'falhou' && found.deviceId !== entry.spec.deviceId)) {
        const previousId = entry.spec.deviceId;
        entry.spec = { ...entry.spec, deviceId: found.deviceId, label: found.label || entry.spec.label };
        void this.start(entry).then(() => {
          if (entry.status === 'ativo') this.events.recovered?.(entry, found, previousId);
        });
      }
    }
  }

  dispose(): void {
    for (const timer of this.pendingRelease.values()) clearTimeout(timer);
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
    this.emit();
  }
}
