import { describe, expect, it } from 'vitest';
import { addToScene, putOnProgram } from './project';
import { withVideoBitrate } from '../phone/phones';
import { EMPTY_PREFERENCES, type DeviceRef, type Project } from '../types/studio';
import { createProject } from './project';
import type { SystemDevice } from '../devices/identify';

const dev = (deviceId: string, label: string, kind: SystemDevice['kind'] = 'videoinput'): SystemDevice => ({ deviceId, label, groupId: '', kind });
const devices = [
  dev('cam1', 'FaceTime HD Camera'),
  dev('celular:a:video', 'Quadra (celular)'),
  dev('celular:a:audio', 'Quadra · microfone (celular)', 'audioinput'),
  dev('celular:b:video', 'Banco (celular)'),
  dev('cam2', 'Placar Cam'),
];
const ref = (id: string): DeviceRef => ({ deviceId: id, label: devices.find((d) => d.deviceId === id)!.label });

function base(): { project: Project; scene: string } {
  const p = createProject([], EMPTY_PREFERENCES);
  const scene = p.scenes[0].id;
  return { project: { ...p, scenes: p.scenes.map((s) => (s.id === scene ? { ...s, items: [] } : s)), activeSceneId: scene }, scene };
}
const ids = (p: Project, scene: string) => p.scenes.find((s) => s.id === scene)!.items.map((i) => p.sources.find((s) => s.id === i.sourceId)!.device.deviceId);
const none = () => false;

describe('putOnProgram', () => {
  it('troca a câmera que estava no ar e leva junto o microfone do celular', () => {
    let { project, scene } = base();
    project = putOnProgram(project, scene, [ref('celular:a:video')], devices, none);
    // microfone do celular entra junto (o App faz isso; aqui simulamos)
    project = addToScene(project, scene, 'audio', ref('celular:a:audio'), devices);
    expect(ids(project, scene)).toEqual(['celular:a:video', 'celular:a:audio']);
    project = putOnProgram(project, scene, [ref('celular:b:video')], devices, none);
    expect(ids(project, scene)).toEqual(['celular:b:video']);
  });

  it('herda posição e camada de quem saiu', () => {
    let { project, scene } = base();
    project = putOnProgram(project, scene, [ref('cam1')], devices, none);
    const t = { x: 0.1, y: 0.1, w: 0.5, h: 0.5, crop: { top: 0, right: 0, bottom: 0, left: 0 } };
    project = { ...project, scenes: project.scenes.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, transform: t as never })) })) };
    project = putOnProgram(project, scene, [ref('cam2')], devices, none);
    const item = project.scenes.find((s) => s.id === scene)!.items[0];
    expect(ids(project, scene)).toEqual(['cam2']);
    expect(item.transform).toEqual(t);
  });

  it('sobreposição entra por cima sem tirar ninguém, e não sai quando outra câmera entra', () => {
    let { project, scene } = base();
    const overlay = (r: DeviceRef) => r.deviceId === 'cam2';
    project = putOnProgram(project, scene, [ref('cam1')], devices, overlay);
    project = putOnProgram(project, scene, [ref('cam2')], devices, overlay);
    expect(ids(project, scene)).toEqual(['cam1', 'cam2']);
    project = putOnProgram(project, scene, [ref('celular:b:video')], devices, overlay);
    expect(ids(project, scene).sort()).toEqual(['cam2', 'celular:b:video']);
  });
});

describe('withVideoBitrate', () => {
  const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10', 'm=video 9 UDP/TLS/RTP/SAVPF 96 102', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ''].join('\r\n');
  it('põe piso/partida/teto no H.264 e no VP8, sem mexer no áudio nem no rtx', () => {
    const out = withVideoBitrate(sdp, 6000);
    expect(out).toContain('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=4800;x-google-min-bitrate=2100;x-google-max-bitrate=6000\r\n');
    expect(out).toContain('a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=4800');
    expect(out).toContain('a=fmtp:111 minptime=10\r\n');
    expect(out).toContain('a=fmtp:103 apt=102\r\n');
    expect(withVideoBitrate(out, 6000)).toBe(out);
  });
});
