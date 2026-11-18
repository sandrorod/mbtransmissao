import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Sessions } from './sessions';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'ses-'));
  const clips = join(root, 'replays');
  mkdirSync(clips);
  writeFileSync(join(clips, 'replay-1700000000000-7s.mp4'), 'a');
  writeFileSync(join(clips, 'replays.json'), '{"meta":{},"folders":[{"id":"f","name":"Jogo 1","collapsed":false}]}');
  return { root, clips, sessions: new Sessions(join(root, 'transmissoes'), clips, join(root, 'atual.json')) };
};

describe('transmissões', () => {
  it('nova transmissão guarda a atual (projeto + replays) e começa sem replays', async () => {
    const { clips, sessions } = setup();
    const before = await sessions.current('Final');
    const info = await sessions.startNew('Semifinal', { name: 'Final', scenes: ['config'] });
    expect(info.name).toBe('Semifinal');
    expect(info.id).not.toBe(before.id);
    expect(readdirSync(clips)).toEqual([]);
    const list = await sessions.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: before.id, name: 'Final', replays: 1 });
  });

  it('recuperar traz o projeto e os replays dela e guarda a que estava aberta', async () => {
    const { clips, sessions } = setup();
    const first = await sessions.current('Final');
    await sessions.startNew('Semifinal', { name: 'Final', marca: 1 });
    writeFileSync(join(clips, 'replay-1700000100000-7s.mp4'), 'b');
    writeFileSync(join(clips, 'replay-1700000200000-7s.mp4'), 'c');
    const back = await sessions.restore(first.id, { name: 'Semifinal', marca: 2 });
    expect(back.project).toEqual({ name: 'Final', marca: 1 });
    expect(readdirSync(clips).sort()).toEqual(['replay-1700000000000-7s.mp4', 'replays.json']);
    expect((await sessions.current()).id).toBe(first.id);
    const list = await sessions.list();
    expect(list.map((s) => [s.name, s.replays])).toEqual([['Semifinal', 2]]);
    // E volta de novo: nada se perde indo e voltando.
    const again = await sessions.restore(list[0].id, back.project);
    expect(again.project).toEqual({ name: 'Semifinal', marca: 2 });
    expect(readdirSync(clips).filter((n) => n.endsWith('.mp4'))).toHaveLength(2);
    expect((await sessions.list()).map((s) => [s.name, s.replays])).toEqual([['Final', 1]]);
  });

  it('apagar remove a transmissão guardada; id inválido é recusado', async () => {
    const { root, sessions } = setup();
    await sessions.startNew('B', { name: 'A' });
    const [s] = await sessions.list();
    expect(await sessions.remove(s.id)).toEqual([]);
    expect(existsSync(join(root, 'transmissoes', s.id))).toBe(false);
    await expect(sessions.restore('../x', {})).rejects.toThrow(/inválida/);
  });
});
