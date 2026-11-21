import { describe, expect, it } from 'vitest';
import { EMPTY_PREFERENCES, type Project } from '../types/studio';
import { addToScene, createProject, sceneHasDevice } from './project';

const cam = { deviceId: 'cam-1', groupId: 'g', label: 'Câmera FaceTime HD', kind: 'videoinput' as const };
const phone = { deviceId: 'celular:abc:video', groupId: 'abc', label: 'Android (celular)', kind: 'videoinput' as const };
const widget = { deviceId: 'pagina:w1', groupId: 'w1', label: 'PLACAR', kind: 'videoinput' as const };
const media = { deviceId: 'midia:m1', groupId: 'm1', label: 'Vinheta', kind: 'videoinput' as const };
const devices = [cam, phone, widget, media];

function base(): Project {
  const p = createProject([], EMPTY_PREFERENCES);
  const scene = p.scenes[0];
  return { ...p, scenes: [{ ...scene, items: [] }], activeSceneId: scene.id };
}

describe('colocar no Programa', () => {
  it('dispositivo entra embaixo de todos os widgets', () => {
    let p = base();
    const scene = p.scenes[0].id;
    p = addToScene(p, scene, 'video', { deviceId: widget.deviceId, label: widget.label }, devices);
    p = addToScene(p, scene, 'video', { deviceId: cam.deviceId, label: cam.label }, devices);
    p = addToScene(p, scene, 'video', { deviceId: phone.deviceId, label: phone.label }, devices);
    const order = p.scenes[0].items.map((i) => p.sources.find((s) => s.id === i.sourceId)!.device.deviceId);
    // A primeira camada fica atrás: câmera, celular, e o widget por cima de tudo.
    expect(order).toEqual(['cam-1', 'celular:abc:video', 'pagina:w1']);
  });
  it('mídia entra por cima de todas as camadas', () => {
    let p = base();
    const scene = p.scenes[0].id;
    p = addToScene(p, scene, 'video', { deviceId: widget.deviceId, label: widget.label }, devices);
    p = addToScene(p, scene, 'video', { deviceId: media.deviceId, label: media.label }, devices);
    p = addToScene(p, scene, 'video', { deviceId: cam.deviceId, label: cam.label }, devices);
    const order = p.scenes[0].items.map((i) => p.sources.find((s) => s.id === i.sourceId)!.device.deviceId);
    expect(order).toEqual(['cam-1', 'pagina:w1', 'midia:m1']);
  });
  it('leva os ajustes feitos na Prévia', () => {
    let p = base();
    const scene = p.scenes[0].id;
    const transform = { x: 0.1, y: 0.2, w: 0.5, crop: { l: 0.1, t: 0, r: 0, b: 0 } };
    p = addToScene(p, scene, 'video', { deviceId: cam.deviceId, label: cam.label }, devices);
    p = { ...p, sources: p.sources.map((s) => ({ ...s, staged: { transform } })), scenes: p.scenes.map((s) => ({ ...s, items: [] })) };
    p = addToScene(p, scene, 'video', { deviceId: cam.deviceId, label: cam.label }, devices);
    expect(p.scenes[0].items[0].transform).toEqual(transform);
    // Já no Programa: "Atualizar no Programa" aplica os ajustes novos.
    const moved = { ...transform, x: 0.3 };
    p = { ...p, sources: p.sources.map((s) => ({ ...s, staged: { transform: moved } })) };
    p = addToScene(p, scene, 'video', { deviceId: cam.deviceId, label: cam.label }, devices);
    expect(p.scenes[0].items).toHaveLength(1);
    expect(p.scenes[0].items[0].transform).toEqual(moved);
  });
});

describe('Prévia salva no projeto', () => {
  it('guarda a lista de elementos e descarta lixo', async () => {
    const { validateProject } = await import('./validate');
    const p = { ...base(), preview: ['cam-1', 'pagina:w1', 42, ''] };
    expect(validateProject(p).preview).toEqual(['cam-1', 'pagina:w1']);
  });
});

describe('borda da fonte', () => {
  it('a borda feita na Prévia vai junto para o Programa e some quando é tirada', () => {
    let p = base();
    const scene = p.scenes[0].id;
    const ref = { deviceId: media.deviceId, label: media.label };
    p = addToScene(p, scene, 'video', ref, devices);
    const border = { style: 'neon' as const, color: '#0090ff', width: 8, radius: 24 };
    p = { ...p, sources: p.sources.map((s) => ({ ...s, staged: { transform: null, border } })) };
    p = addToScene(p, scene, 'video', ref, devices);
    expect(p.scenes[0].items[0].border).toEqual(border);
    p = { ...p, sources: p.sources.map((s) => ({ ...s, staged: { transform: null, border: null } })) };
    p = addToScene(p, scene, 'video', ref, devices);
    expect(p.scenes[0].items[0].border).toBeNull();
  });
});

describe('arrastar dispositivo para a cena', () => {
  it('a mesma fonte vai para várias cenas e não duplica na mesma cena', () => {
    let p = base();
    const a = p.scenes[0].id;
    p = { ...p, scenes: [...p.scenes, { id: 'b', name: 'CENA 2', items: [] }] };
    const ref = { deviceId: cam.deviceId, label: cam.label };
    expect(sceneHasDevice(p, a, 'video', ref, devices)).toBe(false);
    p = addToScene(p, a, 'video', ref, devices);
    expect(sceneHasDevice(p, a, 'video', ref, devices)).toBe(true);
    expect(sceneHasDevice(p, 'b', 'video', ref, devices)).toBe(false);
    p = addToScene(p, 'b', 'video', ref, devices);
    p = addToScene(p, 'b', 'video', ref, devices);
    expect(p.sources).toHaveLength(1);
    expect(p.scenes.map((s) => s.items.map((i) => i.sourceId))).toEqual([[p.sources[0].id], [p.sources[0].id]]);
    // Vídeo e áudio do mesmo aparelho são fontes diferentes.
    expect(sceneHasDevice(p, a, 'audio', ref, devices)).toBe(false);
  });
});
