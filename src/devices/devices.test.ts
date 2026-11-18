import { describe, expect, it } from 'vitest';
import { parseDeviceList, parseModes, usefulFps } from './avfoundation';
import { audioType, diffDevices, findDevice, normalizeLabel, videoType, type SystemDevice } from './identify';
import { MediaPool, type StreamSpec } from './mediaPool';
import { videoChoices, videoConstraints } from './videoOptions';

// Saídas reais do FFmpeg/AVFoundation neste Mac (macOS 13, Intel).
const LIST = `[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] Câmera FaceTime HD (Integrada)
[AVFoundation indev @ 0x7f] [1] OBS Virtual Camera
[AVFoundation indev @ 0x7f] [2] Capture screen 0
[AVFoundation indev @ 0x7f] AVFoundation audio devices:
[AVFoundation indev @ 0x7f] [0] Built-in Microphone
Error opening input file .`;
const MODES = `[avfoundation @ 0x7f] Supported modes:
[avfoundation @ 0x7f]   640x480@[30.000030 30.000030]fps
[avfoundation @ 0x7f]   640x480@[29.000049 29.000049]fps
[avfoundation @ 0x7f]   640x480@[15.000015 15.000015]fps
[avfoundation @ 0x7f]   1280x720@[30.000030 30.000030]fps
[avfoundation @ 0x7f]   1280x720@[25.000000 25.000000]fps
[avfoundation @ 0x7f]   1920x1080@[1.000000 60.000000]fps`;

describe('AVFoundation', () => {
  it('lê a lista de dispositivos', () => {
    expect(parseDeviceList(LIST)).toEqual({ video: ['Câmera FaceTime HD (Integrada)', 'OBS Virtual Camera', 'Capture screen 0'], audio: ['Built-in Microphone'] });
  });
  it('lê os modos reais da câmera', () => {
    const modes = parseModes(MODES);
    expect(modes.map((m) => `${m.width}x${m.height}`)).toEqual(['1920x1080', '1280x720', '640x480']);
    expect(modes[1].fps).toEqual([30, 25]);
    expect(modes[2].fps).toEqual([30, 29, 15]);
    expect(modes[0].fps).toContain(60);
    expect(modes[0].fps).toContain(29.97);
    expect(usefulFps(modes[2].fps)).toEqual([30, 15]);
  });
  it('sem lista de modos não inventa nada', () => expect(parseModes('Error opening input')).toEqual([]));
});

const dev = (deviceId: string, label: string, kind: SystemDevice['kind'] = 'videoinput'): SystemDevice => ({ deviceId, label, kind, groupId: '' });

describe('identificação', () => {
  it('normaliza nomes do Chromium e do macOS', () => {
    expect(normalizeLabel('Cam Link 4K (0fd9:0066)')).toBe('cam link 4k');
    expect(normalizeLabel('Padrão - Built-in Microphone')).toBe('built-in microphone');
    expect(normalizeLabel('Default - Scarlett 2i2 USB')).toBe('scarlett 2i2 usb');
  });
  it('reencontra pelo id e, se mudou, pelo nome', () => {
    const list = [dev('novo-id', 'Cam Link 4K (0fd9:0066)'), dev('x', 'FaceTime HD Camera')];
    expect(findDevice({ deviceId: 'x', label: '' }, list, 'videoinput')?.deviceId).toBe('x');
    expect(findDevice({ deviceId: 'velho-id', label: 'Cam Link 4K' }, list, 'videoinput')?.deviceId).toBe('novo-id');
    expect(findDevice({ deviceId: 'y', label: 'Webcam' }, list, 'videoinput')).toBeNull();
    expect(findDevice({ deviceId: 'x', label: 'FaceTime HD Camera' }, list, 'audioinput')).toBeNull();
  });
  it('ignora as entradas "padrão" que só repetem um dispositivo', () => {
    const list = [dev('default', 'Padrão - Built-in Microphone', 'audioinput'), dev('m', 'Built-in Microphone', 'audioinput')];
    expect(findDevice({ deviceId: 'default', label: 'Padrão - Built-in Microphone' }, list, 'audioinput')?.deviceId).toBe('m');
  });
  it('detecta o que entrou e o que saiu', () => {
    const before = [dev('a', 'FaceTime'), dev('default', 'x', 'audioinput'), dev('m', 'Mic', 'audioinput')];
    const after = [dev('a', 'FaceTime'), dev('b', 'Cam Link 4K'), dev('default', 'y', 'audioinput')];
    const changes = diffDevices(before, after);
    expect(changes.added.map((d) => d.deviceId)).toEqual(['b']);
    expect(changes.removed.map((d) => d.deviceId)).toEqual(['m']);
  });
  it('tipo provável pelo nome do fabricante', () => {
    expect(videoType('Câmera FaceTime HD (Integrada)')).toBe('Câmera integrada');
    expect(videoType('OBS Virtual Camera')).toBe('Câmera virtual');
    expect(videoType('Cam Link 4K')).toBe('Placa de captura');
    expect(videoType('Logitech BRIO')).toBe('Câmera USB');
    expect(audioType('Built-in Microphone')).toBe('Microfone integrado');
    expect(audioType('Scarlett 2i2 USB')).toBe('Interface de áudio');
    expect(audioType('Yamaha MG10XU')).toBe('Mesa de som');
    expect(audioType('Cam Link 4K')).toBe('Áudio da placa de captura');
    expect(audioType('Rode NT-USB')).toBe('Microfone USB');
  });
});

describe('opções de vídeo', () => {
  it('usa só os modos reais quando existem', () => {
    const choices = videoChoices(parseModes(MODES), { width: { max: 4000 }, height: { max: 3000 } });
    expect(choices.source).toBe('avfoundation');
    expect(choices.sizes).toHaveLength(3);
    expect(choices.fpsFor(1280, 720)).toEqual([30, 25]);
  });
  it('sem a lista, filtra pelos limites da câmera', () => {
    const choices = videoChoices(null, { width: { min: 160, max: 1280 }, height: { min: 120, max: 720 }, frameRate: { min: 1, max: 30 } });
    expect(choices.source).toBe('capacidades');
    expect(choices.sizes.every((s) => s.width <= 1280 && s.height <= 720)).toBe(true);
    expect(choices.fpsFor(1280, 720)).not.toContain(60);
    expect(videoChoices(null, null).sizes).toEqual([]);
  });
  it('restrições de captura', () => {
    expect(videoConstraints({ width: 1280, height: 720, fps: 30, aspect: 'original', rotation: 0, mirror: false, extra: {} })).toEqual({ width: { exact: 1280 }, height: { exact: 720 }, frameRate: { ideal: 30, max: 30 } });
    expect(videoConstraints(undefined)).toEqual({});
    // Automático: pede a maior imagem (a FaceTime abria em 640×480 4:3 em vez de 1280×720 16:9).
    expect(videoConstraints({ width: 0, height: 0, fps: 0, aspect: 'original', rotation: 0, mirror: false, extra: {} })).toEqual({ width: { ideal: 1920 }, height: { ideal: 1080 } });
  });
});

// Dispositivo de mentira só para testar o pool sem hardware.
class FakeTrack extends EventTarget {
  stopped = false;
  stop() { this.stopped = true; }
}
const fakeStream = () => {
  const track = new FakeTrack();
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pool de fontes', () => {
  const spec: StreamSpec = { kind: 'video', deviceId: 'cam', label: 'Cam Link 4K', constraints: {} };

  it('abre o dispositivo uma vez só para várias cenas e fecha quando ninguém usa', async () => {
    const tracks: FakeTrack[] = [];
    const pool = new MediaPool(async () => { const f = fakeStream(); tracks.push(f.track); return f.stream; }, {}, 0);
    const a = pool.acquire(spec);
    const b = pool.acquire(spec);
    await flush();
    expect(a).toBe(b);
    expect(pool.opens).toBe(1);
    expect(pool.get(a)?.status).toBe('ativo');
    pool.release(a);
    expect(tracks[0].stopped).toBe(false);
    pool.release(b);
    expect(tracks[0].stopped).toBe(true);
    expect(pool.list()).toHaveLength(0);
  });

  it('configuração diferente abre outra instância', async () => {
    const pool = new MediaPool(async () => fakeStream().stream, {}, 0);
    pool.acquire(spec);
    pool.acquire({ ...spec, constraints: { width: { exact: 1280 } } });
    await flush();
    expect(pool.opens).toBe(2);
  });

  it('dispositivo que cai: só a fonte dele é afetada, e ela volta ao religar', async () => {
    const lost: string[] = [];
    const recovered: string[] = [];
    const tracks: FakeTrack[] = [];
    const pool = new MediaPool(async () => { const f = fakeStream(); tracks.push(f.track); return f.stream; }, {
      lost: (e) => lost.push(e.spec.label),
      recovered: (e) => recovered.push(e.spec.deviceId),
    }, 0);
    const cam = pool.acquire(spec);
    const mic = pool.acquire({ kind: 'audio', deviceId: 'mic', label: 'Scarlett', constraints: {} });
    await flush();

    // O cabo da placa de captura saiu: o macOS encerra a trilha.
    tracks[0].dispatchEvent(new Event('ended'));
    expect(pool.get(cam)?.status).toBe('desconectado');
    expect(pool.get(mic)?.status).toBe('ativo');
    expect(lost).toEqual(['Cam Link 4K']);

    // A lista do sistema confirma que sumiu; nada muda no microfone.
    pool.sync([dev('mic', 'Scarlett', 'audioinput')]);
    expect(pool.get(mic)?.status).toBe('ativo');

    // Religou com outro id: reencontra pelo nome e reabre.
    pool.sync([dev('cam-2', 'Cam Link 4K (0fd9:0066)'), dev('mic', 'Scarlett', 'audioinput')]);
    await flush();
    await flush();
    expect(pool.get(cam)?.status).toBe('ativo');
    expect(pool.get(cam)?.spec.deviceId).toBe('cam-2');
    expect(recovered).toEqual(['cam-2']);
  });

  it('id antigo (outro perfil/origem do Chromium): reencontra pelo nome em vez de ficar em "Falhou"', async () => {
    const pool = new MediaPool(async (c) => {
      const id = ((c.video as MediaTrackConstraints).deviceId as { exact: string }).exact;
      if (id !== 'novo-id') throw Object.assign(new Error('x'), { name: 'OverconstrainedError', constraint: 'deviceId' });
      return fakeStream().stream;
    }, {}, 0);
    const key = pool.acquire({ ...spec, deviceId: 'id-antigo' });
    await flush();
    expect(pool.get(key)?.status).toBe('desconectado');
    pool.sync([dev('novo-id', spec.label)]);
    await flush();
    await flush();
    expect(pool.get(key)?.status).toBe('ativo');
    expect(pool.get(key)?.spec.deviceId).toBe('novo-id');
  });

  it('fonte que falhou reabre quando o mesmo dispositivo aparece com outro id', async () => {
    let calls = 0;
    const pool = new MediaPool(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('x'), { name: 'NotReadableError' });
      return fakeStream().stream;
    }, {}, 0);
    const key = pool.acquire(spec);
    await flush();
    expect(pool.get(key)?.status).toBe('falhou');
    pool.sync([dev('outro-id', spec.label)]);
    await flush();
    await flush();
    expect(pool.get(key)?.status).toBe('ativo');
  });

  it('página de widget (fora da lista do sistema) não é derrubada pela lista', async () => {
    const pool = new MediaPool(async () => fakeStream().stream, { managed: (s) => s.deviceId.startsWith('pagina:') }, 0);
    const key = pool.acquire({ kind: 'video', deviceId: 'pagina:rascunho', label: 'Placar', constraints: {} });
    await flush();
    pool.sync([dev('cam', 'Câmera')]);
    await flush();
    expect(pool.get(key)?.status).toBe('ativo');
  });

  it('setEvents soma regras: a proteção das páginas continua valendo', async () => {
    const pool = new MediaPool(async () => fakeStream().stream, { managed: (s) => s.deviceId.startsWith('pagina:') }, 0);
    pool.setEvents({ lost: () => undefined });
    const key = pool.acquire({ kind: 'video', deviceId: 'pagina:x', label: 'Placar', constraints: {} });
    await flush();
    pool.sync([]);
    expect(pool.get(key)?.status).toBe('ativo');
  });

  it('página que caiu é reaberta na próxima conferência', async () => {
    const tracks: ReturnType<typeof fakeStream>['track'][] = [];
    const pool = new MediaPool(async () => { const f = fakeStream(); tracks.push(f.track); return f.stream; }, { managed: (s) => s.deviceId.startsWith('pagina:') }, 0);
    const key = pool.acquire({ kind: 'video', deviceId: 'pagina:x', label: 'Placar', constraints: {} });
    await flush();
    tracks[0].dispatchEvent(new Event('ended'));
    expect(pool.get(key)?.status).toBe('desconectado');
    pool.sync([]);
    await flush();
    await flush();
    expect(pool.get(key)?.status).toBe('ativo');
  });

  it('sem permissão não é tratado como desconexão', async () => {
    const pool = new MediaPool(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }, {}, 0);
    const key = pool.acquire(spec);
    await flush();
    expect(pool.get(key)?.status).toBe('falhou');
    expect(pool.get(key)?.error).toMatch(/permissão/);
  });
});

describe('nome exibido', () => {
  it('tira o código USB e o prefixo de padrão, mantendo maiúsculas', async () => {
    const { displayName } = await import('./identify');
    expect(displayName('Câmera FaceTime HD (Integrada) (05ac:8600)')).toBe('Câmera FaceTime HD (Integrada)');
    expect(displayName('Default - Internal Microphone (Built-in)')).toBe('Internal Microphone (Built-in)');
  });
});
