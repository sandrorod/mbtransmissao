import type { DeviceKind, DeviceRef } from '../types/studio';

/**
 * Nome comparável: o Chromium às vezes acrescenta "(05ac:8514)" (USB) e o macOS usa "Padrão - " / "Default - "
 * na entrada que representa o dispositivo padrão.
 */
export function normalizeLabel(label: string): string {
  return label
    .replace(/^(default|padrão|communications|comunicações)\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

/** Nome para mostrar ao operador: sem o código USB nem o prefixo de "padrão". */
/** Nomes dados pelo operador (chave: nome normalizado do aparelho). */
let aliases = new Map<string, string>();
export function setDeviceAliases(names: Record<string, string>): void {
  aliases = new Map(Object.entries(names));
}

/** Nome para mostrar: o que o operador deu ao aparelho ou, sem isso, o nome do sistema limpo. */
export function displayName(label: string): string {
  return aliases.get(normalizeLabel(label)) ?? baseName(label);
}

/** Nome do sistema limpo (sem "Padrão -" nem o código USB), ignorando renomeações. */
export function baseName(label: string): string {
  return label
    .replace(/^(default|padrão|communications|comunicações)\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim();
}

/** Entradas que o Chromium cria só para apontar o dispositivo padrão: repetem um dispositivo real. */
export const isAliasDevice = (deviceId: string) => deviceId === 'default' || deviceId === 'communications';

export interface SystemDevice {
  deviceId: string;
  groupId: string;
  label: string;
  kind: 'videoinput' | 'audioinput' | 'audiooutput';
}

export const kindOf = (kind: DeviceKind) => (kind === 'video' ? 'videoinput' : 'audioinput');

/** Reencontra um dispositivo salvo: primeiro pelo id, depois pelo nome (o id pode mudar após religar). */
export function findDevice(ref: DeviceRef, devices: SystemDevice[], kind: SystemDevice['kind']): SystemDevice | null {
  const sameKind = devices.filter((d) => d.kind === kind && !isAliasDevice(d.deviceId));
  return sameKind.find((d) => d.deviceId === ref.deviceId)
    ?? sameKind.find((d) => normalizeLabel(d.label) === normalizeLabel(ref.label))
    ?? null;
}

export interface DeviceChanges {
  added: SystemDevice[];
  removed: SystemDevice[];
}

/** O que mudou entre duas leituras da lista do sistema. */
export function diffDevices(before: SystemDevice[], after: SystemDevice[]): DeviceChanges {
  const id = (d: SystemDevice) => `${d.kind}|${d.deviceId}`;
  const real = (list: SystemDevice[]) => list.filter((d) => !isAliasDevice(d.deviceId));
  const old = new Set(real(before).map(id));
  const now = new Set(real(after).map(id));
  return {
    added: real(after).filter((d) => !old.has(id(d))),
    removed: real(before).filter((d) => !now.has(id(d))),
  };
}

const has = (label: string, words: string[]) => words.some((w) => label.includes(w));

/**
 * Tipo provável, só para ajudar o operador a reconhecer o aparelho na lista.
 * A lista em si vem sempre do sistema; isto apenas lê o nome que o fabricante deu.
 */
export function videoType(label: string): string {
  const l = normalizeLabel(label);
  if (has(l, ['virtual', 'obs ', 'snap camera', 'mmhmm', 'ndi', 'camo', 'continuity'])) return 'Câmera virtual';
  if (has(l, ['facetime', 'integrada', 'built-in', 'isight'])) return 'Câmera integrada';
  if (has(l, ['capture', 'captura', 'hdmi', 'cam link', 'elgato', 'avermedia', 'blackmagic', 'ultrastudio', 'magewell', 'usb video', 'usb3 video', 'hd60', 'live gamer'])) return 'Placa de captura';
  return 'Câmera USB';
}

export function audioType(label: string): string {
  const l = normalizeLabel(label);
  if (has(l, ['built-in', 'integrado', 'macbook', 'imac', 'internal'])) return 'Microfone integrado';
  if (has(l, ['virtual', 'blackhole', 'loopback', 'soundflower', 'obs', 'zoomaudiodevice', 'teams audio'])) return 'Dispositivo virtual';
  if (has(l, ['capture', 'captura', 'hdmi', 'cam link', 'elgato', 'avermedia', 'blackmagic', 'ultrastudio', 'magewell', 'usb video', 'hd60'])) return 'Áudio da placa de captura';
  if (has(l, ['yamaha', 'mixer', 'mesa', 'soundcraft', 'allen', 'x32', 'xr18', 'xr12', 'qu-', 'midas', 'mackie', 'tf1', 'tf3', 'dm3', 'zoom livetrak'])) return 'Mesa de som';
  if (has(l, ['scarlett', 'focusrite', 'behringer', 'umc', 'motu', 'presonus', 'audient', 'steinberg', 'universal audio', 'apollo', 'volt', 'id4', 'id14', 'interface'])) return 'Interface de áudio';
  if (has(l, ['headset', 'airpods', 'jabra', 'bluetooth', 'hands-free', 'plantronics', 'poly '])) return 'Microfone de headset';
  return 'Microfone USB';
}
