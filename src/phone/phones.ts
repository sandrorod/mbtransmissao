import type { SystemDevice } from '../devices/identify';
import { DEFAULT_PHONE_QUALITY, type PhoneEvent, type PhoneQuality, type PhoneSenderStats } from '../types/studio';

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
  /** O que o próprio celular diz que está mandando (e por que reduziu). */
  sent: PhoneSenderStats | null;
}

interface Peer {
  id: string;
  name: string;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  state: PhoneState;
  stats: PhoneStats | null;
  lastBytes: { bytes: number; at: number } | null;
  /** Transceptor por onde o som do Programa volta para o celular (quando ele pede para ouvir). */
  back: RTCRtpTransceiver | null;
  /** O celular quer ouvir a transmissão. */
  listening: boolean;
  /** Último relato de envio do celular. */
  sent: PhoneSenderStats | null;
  /** Quadros decodificados na última checagem e há quantas checagens seguidas não chega quadro novo. */
  frames: number;
  still: number;
  /** Imagem parada (Wi‑Fi caiu, app do celular foi para o fundo): o master pode assumir. */
  stalled: boolean;
}

/** Mensagem do chat entre o operador e um celular. */
export interface ChatMessage {
  from: 'celular' | 'estudio';
  text: string;
  at: number;
}

/**
 * Atraso extra do lado do Estúdio para absorver as oscilações do Wi‑Fi sem engasgar a imagem.
 * 120 ms era pouco: rajadas do Wi‑Fi (e o reenvio de pacotes perdidos) passam disso e a imagem dava
 * "travadinhas". 300 ms cobre a maioria das rajadas e ainda é imperceptível numa transmissão.
 */
const JITTER_BUFFER_MS = 300;

/** Checagens de 1 s sem quadro novo para a imagem contar como parada. */
const STALL_CHECKS = 2;

const newPeer = (id: string, name: string): Peer => ({ id, name, pc: null, stream: null, state: 'conectando', stats: null, lastBytes: null, back: null, listening: false, sent: null, frames: 0, still: 0, stalled: false });

/**
 * Resposta com piso e partida de taxa para o vídeo do celular (parâmetros x-google-*, lidos pelo WebRTC de quem envia).
 * Sem isso o celular começa baixo (~300 kbps) e, depois de uma rajada de perda no Wi‑Fi, desce e demora a subir:
 * a imagem ficava "lavada" depois de um tempo conectado.
 */
export function withVideoBitrate(sdp: string, maxKbps: number): string {
  const start = Math.round(maxKbps * 0.8);
  const min = Math.round(maxKbps * 0.35);
  const params = `x-google-start-bitrate=${start};x-google-min-bitrate=${min};x-google-max-bitrate=${maxKbps}`;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const sections = sdp.split(/(?=^m=)/m);
  return sections.map((section) => {
    if (!section.startsWith('m=video')) return section;
    const pts = [...section.matchAll(/^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//gim)].map((m) => m[1]);
    let out = section.replace(/;?x-google-(start|min|max)-bitrate=\d+/g, '');
    for (const pt of pts) {
      const fmtp = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]*)`, 'm');
      if (fmtp.test(out)) out = out.replace(fmtp, (_l, rest: string) => { const kept = rest.trim().replace(/^;+|;+$/g, ''); return `a=fmtp:${pt} ${kept ? `${kept};` : ''}${params}`; });
      else out = out.replace(new RegExp(`^(a=rtpmap:${pt} [^\\r\\n]*)`, 'm'), `$1${eol}a=fmtp:${pt} ${params}`);
    }
    return out;
  }).join('');
}

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
  /** Celulares cuja câmera está no Programa (o celular fica verde com "AO VIVO"). */
  private onAir = new Set<string>();
  /** Qualidade pedida aos celulares (teto e prioridade); vale para os conectados e os que entrarem. */
  private quality: PhoneQuality = DEFAULT_PHONE_QUALITY;
  /** Som do Programa (mix do mixer) que vai para quem pede "Ouvir transmissão". */
  private programAudio: (() => MediaStreamTrack | null) | null = null;
  /** Conversa de cada celular (fica enquanto o Estúdio estiver aberto, mesmo se ele sair e voltar). */
  private chats = new Map<string, ChatMessage[]>();
  private unread = new Map<string, number>();
  private chatListeners = new Set<() => void>();
  private chatVersion = 0;
  /** Aviso na tela do Estúdio quando chega mensagem. */
  onChatMessage: ((id: string, name: string, text: string) => void) | null = null;

  subscribeChat = (listener: () => void) => {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  };
  getChatVersion = () => this.chatVersion;
  private emitChat(): void {
    this.chatVersion++;
    for (const l of this.chatListeners) l();
  }

  chatOf(deviceOrPhoneId: string): ChatMessage[] {
    return this.chats.get(this.idOf(deviceOrPhoneId)) ?? [];
  }

  unreadOf(deviceOrPhoneId: string): number {
    return this.unread.get(this.idOf(deviceOrPhoneId)) ?? 0;
  }

  markRead(deviceOrPhoneId: string): void {
    const id = this.idOf(deviceOrPhoneId);
    if (!this.unread.get(id)) return;
    this.unread.delete(id);
    this.emitChat();
  }

  sendChat(deviceOrPhoneId: string, text: string): void {
    const id = this.idOf(deviceOrPhoneId);
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    this.pushChat(id, { from: 'estudio', text: clean, at: Date.now() });
    void window.studio.sendToPhone(id, { t: 'chat', texto: clean });
  }

  private pushChat(id: string, message: ChatMessage): void {
    const list = [...(this.chats.get(id) ?? []), message].slice(-200);
    this.chats.set(id, list);
    this.emitChat();
  }

  private idOf(deviceOrPhoneId: string): string {
    return deviceOrPhoneId.startsWith('celular:') ? phoneIdOf(deviceOrPhoneId) : deviceOrPhoneId;
  }

  /** De onde vem o som do Programa (o App passa o mixer). */
  setProgramAudio(get: () => MediaStreamTrack | null): void {
    this.programAudio = get;
    for (const peer of this.peers.values()) this.applyBack(peer);
  }

  /** Liga/desliga o som do Programa indo para o celular (sem renegociar a conexão). */
  private applyBack(peer: Peer): void {
    const sender = peer.back?.sender;
    if (!sender || peer.pc?.connectionState === 'closed') return;
    const track = peer.listening ? this.programAudio?.() ?? null : null;
    if (sender.track === track) return;
    void sender.replaceTrack(track).catch(() => undefined);
  }

  /** Quais celulares estão no Programa agora: avisa só os que mudaram. */
  setOnAir(ids: Iterable<string>): void {
    const next = new Set(ids);
    for (const id of next) if (!this.onAir.has(id)) void window.studio.sendToPhone(id, { t: 'no-ar', on: true });
    for (const id of this.onAir) if (!next.has(id)) void window.studio.sendToPhone(id, { t: 'no-ar', on: false });
    this.onAir = next;
  }

  setQuality(quality: PhoneQuality): void {
    if (quality.mbps === this.quality.mbps && quality.priority === this.quality.priority) return;
    this.quality = quality;
    for (const peer of this.peers.values()) if (peer.pc?.connectionState === 'connected') this.sendQuality(peer.id);
  }

  private sendQuality(id: string): void {
    void window.studio.sendToPhone(id, { t: 'qualidade', mbps: this.quality.mbps, prioridade: this.quality.priority });
  }

  /** Imagem do celular parada há ~2 s (ou conexão caindo). */
  isStalled(deviceId: string): boolean {
    return this.peers.get(phoneIdOf(deviceId))?.stalled ?? false;
  }

  private setStalled(peer: Peer, stalled: boolean): void {
    if (peer.stalled === stalled) return;
    peer.stalled = stalled;
    this.emit();
  }

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
    // A cada 1 s: números da recepção e, principalmente, imagem parada (para o master assumir rápido).
    setInterval(() => void this.collectStats(), 1000);
    this.refreshIce();
    window.studio.onPhoneEvent((event) => void this.handle(event));
    const list = await window.studio.phonesReady();
    for (const p of list) if (!this.peers.has(p.id)) this.peers.set(p.id, newPeer(p.id, p.name));
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
      if (!peer.pc || peer.pc.connectionState !== 'connected') {
        if (peer.pc?.connectionState === 'disconnected') this.setStalled(peer, true);
        continue;
      }
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
      // Imagem parada: nenhum quadro novo decodificado nas últimas checagens.
      const frames = Number(v.framesDecoded ?? 0);
      peer.still = frames > peer.frames ? 0 : peer.still + 1;
      peer.frames = frames;
      this.setStalled(peer, peer.still >= STALL_CHECKS);
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
        sent: peer.sent,
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
      else this.peers.set(event.id, newPeer(event.id, event.nome));
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
    if (event.t === 'chat') {
      const peer = this.peers.get(event.id);
      this.pushChat(event.id, { from: 'celular', text: event.texto, at: Date.now() });
      this.unread.set(event.id, (this.unread.get(event.id) ?? 0) + 1);
      this.emitChat();
      this.onChatMessage?.(event.id, peer?.name ?? 'Celular', event.texto);
      return;
    }
    if (event.t === 'ouvir') {
      const peer = this.peers.get(event.id);
      if (peer) {
        peer.listening = event.on;
        this.applyBack(peer);
      }
      return;
    }
    if (event.t === 'falha') {
      window.studio.liveLog(`celular ${this.peers.get(event.id)?.name ?? event.id}: ${event.texto}`);
      return;
    }
    if (event.t === 'estat') {
      const peer = this.peers.get(event.id);
      if (peer) {
        peer.sent = event.dados;
        if (peer.stats) peer.stats = { ...peer.stats, sent: event.dados };
        this.emitStats();
      }
      return;
    }
    if (event.t === 'nome') {
      const peer = this.peers.get(event.id);
      if (peer) peer.name = event.nome;
      this.emit();
      return;
    }
    const data = event.dados as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; retorno?: string | null } | null;
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
        if (pc.connectionState === 'connected') {
          peer.state = 'ao-vivo';
          peer.still = 0;
          this.setStalled(peer, false);
          this.sendQuality(peer.id);
          // Celular reconectou: volta a saber se está no ar.
          void window.studio.sendToPhone(peer.id, { t: 'no-ar', on: this.onAir.has(peer.id) });
        }
        else if (pc.connectionState === 'disconnected') {
          // Wi‑Fi do celular oscilou: costuma voltar sozinho, mas a imagem já está parada.
          this.setStalled(peer, true);
        }
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
      peer.back = null;
      peer.frames = 0;
      peer.still = 0;
      await pc.setRemoteDescription(data.sdp);
      // Canal de volta pedido pelo celular: mandamos o som do Programa por ele quando o celular pedir.
      if (data.retorno) {
        const back = pc.getTransceivers().find((t) => t.mid === data.retorno) ?? null;
        if (back) {
          back.direction = 'sendonly';
          peer.back = back;
          this.applyBack(peer);
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const local = pc.localDescription?.toJSON();
      // Só a cópia que vai para o celular leva o piso/partida de taxa (é o celular que envia o vídeo).
      const sdp = local?.sdp ? { ...local, sdp: withVideoBitrate(local.sdp, this.quality.mbps * 1000) } : local;
      void window.studio.sendToPhone(peer.id, { t: 'sinal', dados: { sdp } });
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
