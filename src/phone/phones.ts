import type { SystemDevice } from '../devices/identify';
import type { PhoneEvent } from '../types/studio';

export type PhoneState = 'conectando' | 'ao-vivo' | 'sem-video';

/** O que realmente chega do celular (lido das estatísticas do WebRTC a cada 2 s). */
export interface PhoneStats {
  fps: number;
  width: number;
  height: number;
  kbps: number;
  codec: string;
  /** Pacotes perdidos no Wi‑Fi, em %. */
  lost: number;
  /** Travamentos de imagem detectados pelo navegador desde a conexão. */
  freezes: number;
}

interface Peer {
  id: string;
  name: string;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  state: PhoneState;
  stats: PhoneStats | null;
  lastBytes: { bytes: number; at: number } | null;
}

/**
 * Atraso extra do lado do Estúdio para absorver as oscilações do Wi‑Fi sem engasgar a imagem.
 * 120 ms era pouco: rajadas do Wi‑Fi (e o reenvio de pacotes perdidos) passam disso e a imagem dava
 * "travadinhas". 300 ms cobre a maioria das rajadas e ainda é imperceptível numa transmissão.
 */
const JITTER_BUFFER_MS = 300;

/** Prefixo dos ids de celular na lista de dispositivos: "celular:<id>:video" / "celular:<id>:audio". */
export const phoneDeviceId = (id: string, kind: 'video' | 'audio') => `celular:${id}:${kind}`;
export const phoneIdOf = (deviceId: string) => deviceId.split(':')[1] ?? '';

/**
 * Recebe o vídeo dos celulares. O celular manda a oferta; aqui só se responde (o mesmo papel do
 * painel do SecurityCam). Cada celular vira uma câmera e, se mandar som, um microfone.
 */
export class PhoneManager {
  private peers = new Map<string, Peer>();
  private listeners = new Set<() => void>();
  private started = false;
  /** STUN/TURN atuais (lidos no começo e sempre que um celular entra, sem atrasar a resposta). */
  private ice: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  version = 0;

  refreshIce(): void {
    void window.studio.phoneIce().then((list) => { if (list.length) this.ice = list; }, () => undefined);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /**
   * Números da recepção (a cada 2 s) têm aviso próprio: avisar pelo emit() redesenhava o App inteiro a cada 2 s
   * com um celular ligado e, no Mac lento, o Programa engasgava junto (mídia, vinheta e câmeras).
   */
  private statsListeners = new Set<() => void>();
  private statsVersion = 0;
  subscribeStats = (listener: () => void) => {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  };
  getStatsVersion = () => this.statsVersion;
  private emitStats(): void {
    this.statsVersion++;
    for (const l of this.statsListeners) l();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    setInterval(() => void this.collectStats(), 2000);
    this.refreshIce();
    window.studio.onPhoneEvent((event) => void this.handle(event));
    const list = await window.studio.phonesReady();
    for (const p of list) if (!this.peers.has(p.id)) this.peers.set(p.id, { id: p.id, name: p.name, pc: null, stream: null, state: 'conectando', stats: null, lastBytes: null });
    this.emit();
  }

  list(): { id: string; name: string; state: PhoneState; stream: MediaStream | null; stats: PhoneStats | null }[] {
    return [...this.peers.values()].map(({ id, name, state, stream, stats }) => ({ id, name, state, stream, stats }));
  }

  statsOf(deviceId: string): PhoneStats | null {
    return this.peers.get(phoneIdOf(deviceId))?.stats ?? null;
  }

  private async collectStats(): Promise<void> {
    let changed = false;
    for (const peer of this.peers.values()) {
      if (!peer.pc || peer.pc.connectionState !== 'connected') continue;
      const report = await peer.pc.getStats().catch(() => null);
      if (!report) continue;
      let video: Record<string, number | string> | null = null;
      const codecs = new Map<string, string>();
      report.forEach((r: Record<string, number | string>) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') video = r;
        if (r.type === 'codec') codecs.set(String(r.id), String(r.mimeType ?? '').replace(/^video\//, ''));
      });
      if (!video) continue;
      const v = video as Record<string, number | string>;
      const bytes = Number(v.bytesReceived ?? 0);
      const now = performance.now();
      const kbps = peer.lastBytes ? Math.round(((bytes - peer.lastBytes.bytes) * 8) / (now - peer.lastBytes.at)) : 0;
      peer.lastBytes = { bytes, at: now };
      const received = Number(v.packetsReceived ?? 0);
      const lostPackets = Number(v.packetsLost ?? 0);
      peer.stats = {
        fps: Math.round(Number(v.framesPerSecond ?? 0)),
        width: Number(v.frameWidth ?? 0),
        height: Number(v.frameHeight ?? 0),
        kbps,
        codec: codecs.get(String(v.codecId)) ?? '',
        lost: received + lostPackets > 0 ? Math.round((lostPackets / (received + lostPackets)) * 1000) / 10 : 0,
        freezes: Number(v.freezeCount ?? 0),
      };
      changed = true;
    }
    if (changed) this.emitStats();
  }

  /** Celulares como dispositivos (só os que já mandaram imagem/som). */
  devices(): SystemDevice[] {
    const result: SystemDevice[] = [];
    for (const p of this.peers.values()) {
      if (!p.stream) continue;
      if (p.stream.getVideoTracks().some((t) => t.readyState === 'live')) result.push({ deviceId: phoneDeviceId(p.id, 'video'), groupId: p.id, label: `${p.name} (celular)`, kind: 'videoinput' });
      if (p.stream.getAudioTracks().some((t) => t.readyState === 'live')) result.push({ deviceId: phoneDeviceId(p.id, 'audio'), groupId: p.id, label: `${p.name} · microfone (celular)`, kind: 'audioinput' });
    }
    return result;
  }

  /** Trilha do celular para uma fonte; é uma cópia, para fechar a fonte não derrubar o celular. */
  track(deviceId: string): MediaStreamTrack | null {
    const [, id, kind] = deviceId.split(':');
    const stream = this.peers.get(id)?.stream;
    const track = (kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks())?.find((t) => t.readyState === 'live');
    return track ? track.clone() : null;
  }

  command(id: string, action: 'trocar-camera' | 'mudo' | 'som'): void {
    void window.studio.sendToPhone(id, { t: 'comando', acao: action });
  }

  remove(id: string): void {
    const peer = this.peers.get(id);
    peer?.pc?.close();
    this.peers.delete(id);
    void window.studio.removePhone(id);
    this.emit();
  }

  private async handle(event: PhoneEvent): Promise<void> {
    if (event.t === 'entrou') {
      this.refreshIce();
      const peer = this.peers.get(event.id);
      if (peer) peer.name = event.nome;
      else this.peers.set(event.id, { id: event.id, name: event.nome, pc: null, stream: null, state: 'conectando', stats: null, lastBytes: null });
      this.emit();
      return;
    }
    if (event.t === 'saiu') {
      const peer = this.peers.get(event.id);
      peer?.pc?.close();
      peer?.stream?.getTracks().forEach((t) => t.stop());
      this.peers.delete(event.id);
      this.emit();
      return;
    }
    if (event.t === 'nome') {
      const peer = this.peers.get(event.id);
      if (peer) peer.name = event.nome;
      this.emit();
      return;
    }
    const data = event.dados as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | null;
    const peer = this.peers.get(event.id);
    if (!peer || !data) return;
    if (data.sdp?.type === 'offer') {
      // Oferta nova (o celular reconectou ou trocou de rede): começa uma conexão nova.
      peer.pc?.close();
      // Mesmos STUN/TURN do celular: com TURN, o vídeo atravessa redes 4G que bloqueiam conexão direta.
      const pc = new RTCPeerConnection({ iceServers: this.ice });
      peer.pc = pc;
      peer.state = 'conectando';
      pc.ontrack = (e) => {
        if (peer.pc !== pc) return;
        // Um pequeno buffer de recepção troca 0,1 s de atraso por imagem sem engasgos no Wi‑Fi.
        try {
          (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = JITTER_BUFFER_MS;
        } catch {
          // Navegador sem esse ajuste: segue com o padrão.
        }
        const stream = peer.stream && peer.stream.getTracks().every((t) => t.readyState === 'live') ? peer.stream : new MediaStream();
        if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
        if (e.track.kind === 'audio') keepRemoteAudioFlowing(e.track);
        peer.stream = stream;
        this.emit();
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && peer.pc === pc) void window.studio.sendToPhone(peer.id, { t: 'sinal', dados: { candidate: e.candidate.toJSON() } });
      };
      pc.onconnectionstatechange = () => {
        if (peer.pc !== pc) return;
        if (pc.connectionState === 'connected') peer.state = 'ao-vivo';
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          peer.state = 'sem-video';
          peer.stream?.getTracks().forEach((t) => t.stop());
          peer.stream = null;
        }
        this.emit();
      };
      peer.stream = null;
      peer.stats = null;
      peer.lastBytes = null;
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      void window.studio.sendToPhone(peer.id, { t: 'sinal', dados: { sdp: pc.localDescription?.toJSON() } });
      this.emit();
    } else if (data.candidate && peer.pc) {
      await peer.pc.addIceCandidate(data.candidate).catch(() => undefined);
    }
  }
}

export const phones = new PhoneManager();

/**
 * O Chromium só entrega o som remoto do WebRTC ao WebAudio (mixer) se a trilha também estiver num elemento
 * de mídia. Elemento mudo: não sai no alto-falante, só mantém o áudio do celular chegando ao mixer.
 */
const audioSinks = new Map<MediaStreamTrack, HTMLAudioElement>();
function keepRemoteAudioFlowing(track: MediaStreamTrack): void {
  // Trilhas de conexões antigas (celular reconectou) não disparam 'ended' ao fechar: limpa aqui.
  for (const [old, el] of audioSinks) if (old.readyState === 'ended') { el.srcObject = null; el.remove(); audioSinks.delete(old); }
  if (audioSinks.has(track)) return;
  const sink = document.createElement('audio');
  sink.muted = true;
  sink.autoplay = true;
  sink.srcObject = new MediaStream([track]);
  sink.setAttribute('aria-hidden', 'true');
  sink.style.display = 'none';
  document.body.appendChild(sink);
  void sink.play().catch(() => undefined);
  audioSinks.set(track, sink);
}
