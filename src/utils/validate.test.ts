import { describe, expect, it } from 'vitest';
import { validatePreferences, validateProject, turnServer } from './validate';

const v1 = {
  version: 1,
  name: 'Antigo',
  sources: [{ id: 's1', kind: 'video', name: 'Cam', device: { deviceId: 'a', label: 'Cam' }, video: { width: 0, height: 0, fps: 0, aspect: 'original', rotation: 0, mirror: false, extra: {} } }],
  scenes: [
    { id: 'j', name: 'JOGO', sourceIds: ['s1', 'apagada'] },
    { id: 'e', name: 'ENTREVISTA', sourceIds: [] },
    { id: 'i', name: 'INTERVALO', sourceIds: ['s1'] },
  ],
  activeSceneId: 'j',
  roles: {},
  monitorOutput: null,
};

describe('projeto', () => {
  it('projeto da primeira versão vira camadas, sem perder cenas', () => {
    const p = validateProject(v1);
    expect(p.scenes.map((s) => s.name)).toEqual(['JOGO', 'ENTREVISTA', 'INTERVALO']);
    expect(p.scenes[0].items).toEqual([{ sourceId: 's1', transform: null, hidden: false, folder: null }]);
    expect(p.pages).toEqual([]);
  });
  it('recusa corte impossível e página com endereço perigoso', () => {
    const bad = { ...v1, scenes: [{ id: 'j', name: 'J', items: [{ sourceId: 's1', transform: { x: 0, y: 0, w: 1, crop: { l: 0.6, t: 0, r: 0.6, b: 0 } }, hidden: false }] }] };
    expect(() => validateProject(bad)).toThrow(/corte/);
    expect(() => validateProject({ ...v1, pages: [{ id: 'p', name: 'x', url: 'javascript:alert(1)', width: 1280, height: 720 }] })).toThrow(/página/);
    expect(() => validateProject({ ...v1, pages: [{ id: 'p', name: 'x', url: 'file:///etc/passwd', width: 1280, height: 720 }] })).toThrow(/página/);
  });
  it('widget guarda volume/mudo do som da página; câmera não ganha áudio', () => {
    const video = v1.sources[0].video;
    const p = validateProject({
      ...v1,
      sources: [
        { id: 'w', kind: 'video', name: 'Placar', device: { deviceId: 'pagina:x', label: 'Placar' }, video, audio: { volume: 0.5, muted: true } },
        { id: 'c', kind: 'video', name: 'Cam', device: { deviceId: 'a', label: 'Cam' }, video, audio: { volume: 0.5 } },
      ],
    });
    expect(p.sources[0].audio).toMatchObject({ volume: 0.5, muted: true, stereo: true });
    expect(p.sources[1].audio).toBeUndefined();
    expect(() => validateProject({ ...v1, sources: [{ id: 'w', kind: 'video', name: 'P', device: { deviceId: 'pagina:x', label: 'P' }, video, audio: { volume: 9 } }] })).toThrow(/áudio/);
  });
  it('widget marcado "com som" continua marcado; antigos ficam sem som', () => {
    const page = { id: 'p', name: 'Placar', url: 'https://placar.com', width: 1280, height: 720 };
    expect(validateProject({ ...v1, pages: [{ ...page, audio: true }] }).pages[0].audio).toBe(true);
    expect(validateProject({ ...v1, pages: [page] }).pages[0].audio).toBe(false);
  });
  it('cadeado antigo do widget passa para as fontes dele nas cenas', () => {
    const page = { id: 'p', name: 'Placar', url: 'https://placar.com', width: 1280, height: 720, locked: true };
    const video = v1.sources[0].video;
    const p = validateProject({
      ...v1,
      pages: [page],
      sources: [...v1.sources, { id: 'w', kind: 'video', name: 'Placar', device: { deviceId: 'pagina:p', label: 'Placar' }, video }],
      scenes: [{ id: 's', name: 'S', items: [{ sourceId: v1.sources[0].id, transform: null, hidden: false }, { sourceId: 'w', transform: null, hidden: false }], folders: [{ id: 'f', name: 'P', collapsed: false, locked: true }] }],
    });
    expect(p.scenes[0].items.map((i) => Boolean(i.locked))).toEqual([false, true]);
    expect(p.scenes[0].folders?.[0].locked).toBe(true);
    expect('locked' in p.pages[0]).toBe(false);
  });
  it('replay: duração entre 7 e 30 s', () => {
    expect(validatePreferences({ replaySeconds: 20 }).replaySeconds).toBe(20);
    expect(validatePreferences({ replaySeconds: 3 }).replaySeconds).toBe(15);
    expect(validatePreferences({}).replaySeconds).toBe(15);
  });
  it('preferências antigas ganham os campos novos', () => {
    const prefs = validatePreferences({ camera: null, microphone: null, audioInterface: null, monitorOutput: null });
    expect(prefs.hidden).toEqual([]);
    expect(prefs.output.encoder).toBe('hardware');
    expect(validatePreferences({ publicAddress: 'javascript:x' }).publicAddress).toBe('');
  });
});

describe('TURN dos celulares', () => {
  it('aceita turn:/turns: com usuário e senha', () => {
    expect(turnServer({ urls: ' turn:global.relay.metered.ca:80 , turns:global.relay.metered.ca:443?transport=tcp', username: 'u', credential: 's' }))
      .toEqual({ urls: 'turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp', username: 'u', credential: 's' });
  });
  it('recusa o resto', () => {
    expect(turnServer({ urls: 'http://x.com', username: 'u', credential: 's' })).toBeNull();
    expect(turnServer({ urls: 'turn:x.com:3478', username: '', credential: 's' })).toBeNull();
    expect(turnServer({ urls: 'turn:x.com;rm -rf', username: 'u', credential: 's' })).toBeNull();
    expect(turnServer(null)).toBeNull();
  });
});

describe('qualidade padrão', () => {
  it('vem em 1080p30 a 8000k e sobe quem estava no padrão antigo', () => {
    expect(validatePreferences({}).output).toMatchObject({ width: 1920, height: 1080, fps: 30, bitrate: 8000 });
    expect(validatePreferences({ output: { width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'x264' } }).output).toMatchObject({ bitrate: 8000, encoder: 'x264' });
    expect(validatePreferences({ output: { width: 1280, height: 720, fps: 30, bitrate: 4000, encoder: 'hardware' } }).output.bitrate).toBe(4000);
  });
});


describe('borda', () => {
  it('aceita borda válida e corrige/descarta valores ruins', async () => {
    const { borderOf } = await import('./validate');
    expect(borderOf({ style: 'dupla', color: '#AABBCC', width: 10, radius: 30 })).toEqual({ style: 'dupla', color: '#AABBCC', width: 10, radius: 30 });
    expect(borderOf({ style: 'solida', color: 'red', width: 999, radius: -1 })).toEqual({ style: 'solida', color: '#ffffff', width: 6, radius: 0 });
    expect(borderOf({ style: 'xyz' })).toBeNull();
    expect(borderOf(null)).toBeNull();
  });
});

describe('arquivo de layout', () => {
  it('salvar e importar devolve exatamente o mesmo layout', async () => {
    const { layoutFile } = await import('./validate');
    const { DEFAULT_LAYOUT } = await import('../types/studio');
    const custom = { ...DEFAULT_LAYOUT, leftWidth: 433, bottomHeight: 287, devicesHeight: 0.42 };
    const saved = JSON.parse(JSON.stringify({ kind: 'estudio-layout', version: 1, layout: custom, hud: { quality: false, viewers: true, chat: true }, window: { x: 10, y: 20, width: 1600, height: 900, maximized: false, fullscreen: true } }));
    const back = layoutFile(saved);
    expect(back.layout).toEqual(custom);
    expect(back.hud).toEqual({ quality: false, viewers: true, chat: true });
    expect(back.window).toEqual({ x: 10, y: 20, width: 1600, height: 900, maximized: false, fullscreen: true });
  });
  it('recusa arquivo que não é de layout', async () => {
    const { layoutFile } = await import('./validate');
    expect(() => layoutFile({ version: 1, name: 'projeto' })).toThrow(/não é um layout/);
    expect(() => layoutFile({ kind: 'estudio-layout', layout: {} })).toThrow(/incompleto/);
  });
});

describe('vinhetas do replay', () => {
  it('formato antigo (seconds) vira corte do fim; corte inválido volta para "até o fim"', async () => {
    const { replayIntro } = await import('./validate');
    const old = replayIntro({ name: 'a.mp4', ext: 'mp4', seconds: 4.25, sound: true });
    expect(old).toMatchObject({ start: 0, end: 4.3 });
    expect(replayIntro({ name: 'a.mp4', ext: 'mp4', start: 2, end: 6 })).toMatchObject({ start: 2, end: 6 });
    expect(replayIntro({ name: 'a.mp4', ext: 'mp4', start: 5, end: 3 })).toMatchObject({ start: 5, end: 0 });
    expect(replayIntro({ name: 'a.exe', ext: 'exe' })).toBeNull();
  });
  it('vinheta de saída é guardada nas preferências', async () => {
    const { validatePreferences } = await import('./validate');
    const p = validatePreferences({ replayOutro: { name: 's.mov', ext: 'mov', start: 1, end: 0 } });
    expect(p.replayOutro).toMatchObject({ name: 's.mov', start: 1, end: 0 });
    expect(validatePreferences({}).replayOutro).toBeNull();
  });
});

