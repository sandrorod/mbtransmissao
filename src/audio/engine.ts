import type { AudioSettings } from '../types/studio';

let context: AudioContext | null = null;

/** Um único contexto de áudio para o app inteiro. */
export function audioContext(): AudioContext {
  if (!context) {
    const c = new AudioContext({ latencyHint: 'interactive' });
    context = c;
    // O macOS pode suspender o áudio (troca de saída, fone, descanso de tela). Sem áudio, o gravador da
    // transmissão segura também o vídeo e a live congela: volta a rodar sozinho na hora.
    c.addEventListener('statechange', () => {
      if (c.state !== 'running' && c.state !== 'closed') void c.resume().catch(() => undefined);
    });
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

/** Relógio do áudio do programa (para saber se ele está andando durante a transmissão). */
export function audioClock(): { state: string; time: number } {
  const c = audioContext();
  return { state: c.state, time: c.currentTime };
}

/** Tenta destravar o áudio do programa (contexto suspenso ou interrompido). */
export async function resumeAudio(): Promise<void> {
  const c = audioContext();
  if (c.state !== 'running') await c.resume().catch(() => undefined);
}

/** O Chromium só processa nós ligados até a saída: um ganho zero mantém os medidores vivos sem som. */
function keepAlive(node: AudioNode): AudioNode {
  const c = audioContext();
  const silent = c.createGain();
  silent.gain.value = 0;
  node.connect(silent).connect(c.destination);
  return silent;
}

function peakOf(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (const x of data) peak = Math.max(peak, Math.abs(x));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Nível de sinal de uma entrada, sem tocar nada. */
export class LevelMeter {
  private source: MediaStreamAudioSourceNode;
  private analyser: AnalyserNode;
  private silent: AudioNode;
  private data: Float32Array<ArrayBuffer>;

  constructor(stream: MediaStream) {
    const c = audioContext();
    this.source = c.createMediaStreamSource(stream);
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    this.silent = keepAlive(this.analyser);
  }

  /** Pico em dBFS: 0 é o máximo; -Infinity é silêncio absoluto. */
  peak(): number {
    return peakOf(this.analyser, this.data);
  }

  dispose(): void {
    this.source.disconnect();
    this.analyser.disconnect();
    this.silent.disconnect();
  }
}

interface Channel {
  stream: MediaStream;
  structure: string;
  nodes: AudioNode[];
  input: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  monitor: GainNode;
  data: Float32Array<ArrayBuffer>;
}

/**
 * Mixer: cada fonte de áudio passa por canal → corte de graves → mono/estéreo → volume → mudo,
 * soma no master (a mix do programa) e, se pedido, vai para o monitoramento.
 */
export class Mixer {
  private channels = new Map<string, Channel>();
  private master: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterData = new Float32Array(1024);
  private monitorBus: GainNode | null = null;
  private monitorElement: HTMLAudioElement | null = null;
  private program: MediaStreamAudioDestinationNode | null = null;
  private testRoute: { source: MediaStreamAudioSourceNode; stream: MediaStream } | null = null;

  private ensure(): AudioContext {
    const c = audioContext();
    if (this.master) return c;
    this.master = c.createGain();
    this.masterAnalyser = c.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.master.connect(this.masterAnalyser);
    keepAlive(this.masterAnalyser);
    // Mix do programa, pronta para o módulo de transmissão.
    this.program = c.createMediaStreamDestination();
    this.master.connect(this.program);
    this.monitorBus = c.createGain();
    const monitorOut = c.createMediaStreamDestination();
    this.monitorBus.connect(monitorOut);
    this.monitorElement = new Audio();
    this.monitorElement.srcObject = monitorOut.stream;
    void this.monitorElement.play().catch(() => undefined);
    return c;
  }

  /** Mix final do programa (o que vai para a transmissão). */
  programStream(): MediaStream {
    this.ensure();
    return this.program!.stream;
  }

  /** Saída onde o operador escuta o monitoramento; vazio = saída padrão do macOS. */
  async setMonitorOutput(deviceId: string | null): Promise<void> {
    this.ensure();
    const element = this.monitorElement as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    await element.setSinkId?.(deviceId ?? '');
  }

  update(id: string, stream: MediaStream | null, settings: AudioSettings): void {
    const c = this.ensure();
    const current = this.channels.get(id);
    if (!stream) {
      this.remove(id);
      return;
    }
    const channelCount = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2;
    const structure = `${settings.channel}|${settings.stereo}|${settings.highPass}|${channelCount}`;
    if (!current || current.stream !== stream || current.structure !== structure) {
      this.remove(id);
      const input = c.createMediaStreamSource(stream);
      const nodes: AudioNode[] = [];
      let last: AudioNode = input;
      if (settings.channel !== 'all') {
        // Um canal só da interface/mesa (ex.: entrada 2 = microfone do narrador), em mono.
        const splitter = c.createChannelSplitter(Math.max(channelCount, settings.channel + 1));
        const merger = c.createChannelMerger(2);
        last.connect(splitter);
        splitter.connect(merger, settings.channel, 0);
        splitter.connect(merger, settings.channel, 1);
        nodes.push(splitter, merger);
        last = merger;
      }
      if (settings.highPass) {
        const filter = c.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 80;
        last.connect(filter);
        nodes.push(filter);
        last = filter;
      }
      if (!settings.stereo) {
        const mono = c.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = 'explicit';
        mono.channelInterpretation = 'speakers';
        last.connect(mono);
        nodes.push(mono);
        last = mono;
      }
      const gain = c.createGain();
      const analyser = c.createAnalyser();
      analyser.fftSize = 1024;
      const monitor = c.createGain();
      last.connect(gain);
      gain.connect(analyser);
      gain.connect(this.master!);
      gain.connect(monitor);
      monitor.connect(this.monitorBus!);
      this.channels.set(id, { stream, structure, nodes, input, gain, analyser, monitor, data: new Float32Array(1024) });
    }
    const channel = this.channels.get(id)!;
    channel.gain.gain.setTargetAtTime(settings.muted ? 0 : settings.volume, c.currentTime, 0.015);
    channel.monitor.gain.setTargetAtTime(settings.monitor ? 1 : 0, c.currentTime, 0.015);
  }

  remove(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    for (const node of [channel.input, ...channel.nodes, channel.gain, channel.analyser, channel.monitor]) node.disconnect();
    this.channels.delete(id);
  }

  /** Pico do canal depois do volume e do mudo, em dBFS. */
  peak(id: string): number {
    const channel = this.channels.get(id);
    return channel ? peakOf(channel.analyser, channel.data) : -Infinity;
  }

  masterPeak(): number {
    this.ensure();
    return peakOf(this.masterAnalyser!, this.masterData);
  }

  /** Teste de um dispositivo: manda a entrada direto para o monitoramento, fora da mix do programa. */
  listen(stream: MediaStream | null): void {
    const c = this.ensure();
    if (this.testRoute?.stream === stream) return;
    this.testRoute?.source.disconnect();
    this.testRoute = null;
    if (!stream) return;
    const source = c.createMediaStreamSource(stream);
    source.connect(this.monitorBus!);
    this.testRoute = { source, stream };
  }
}

export const mixer = new Mixer();

/** Restrições de captura do áudio: os filtros do sistema só são pedidos quando ligados. */
export function audioConstraints(settings: AudioSettings | undefined): MediaTrackConstraints {
  const s = settings;
  const c: MediaTrackConstraints = {
    echoCancellation: s?.echoCancellation ?? false,
    noiseSuppression: s?.noiseSuppression ?? false,
    autoGainControl: s?.autoGainControl ?? false,
  };
  if (s?.sampleRate) c.sampleRate = { exact: s.sampleRate };
  return c;
}

/** dBFS → 0 a 1 para a barra de nível (escala de -60 a 0 dB). */
export const levelFraction = (db: number) => (Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 60)) : 0);
