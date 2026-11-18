import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YoutubeAccounts } from './youtubeAccounts';

const vault = { encrypt: (t: string) => `enc:${t}`, decrypt: (d: string) => d.replace(/^enc:/, '') };
const make = (file: string) => new YoutubeAccounts({ file, vault, fetch: (() => { throw new Error('sem rede'); }) as unknown as typeof fetch, openBrowser: () => undefined });
const dir = () => mkdtempSync(join(tmpdir(), 'yta-'));

describe('canais do YouTube', () => {
  it('a conta da versão anterior vira o canal principal, sem perder o acesso', async () => {
    const file = join(dir(), 'youtube.json');
    writeFileSync(file, JSON.stringify({ clientId: '1-a.apps.googleusercontent.com', clientSecretEnc: 'enc:GOCSPX-x', refreshTokenEnc: 'enc:tok', channel: { id: 'UC1', title: 'Canal A', thumbnail: null } }));
    const yt = make(file);
    const list = await yt.list();
    expect(list).toEqual([{ id: 'principal', configured: true, connected: true, channel: { id: 'UC1', title: 'Canal A', thumbnail: null }, clientId: '1-a.apps.googleusercontent.com' }]);
  });

  it('canal novo usa o mesmo cliente OAuth e fica esperando o login; cada canal guarda o seu', async () => {
    const file = join(dir(), 'youtube.json');
    const yt = make(file);
    await yt.add();
    await (await yt.get('principal')).setClient('1-a.apps.googleusercontent.com', 'GOCSPX-segredo123');
    const two = await yt.add();
    expect(two).toHaveLength(2);
    expect(two[1]).toMatchObject({ configured: true, connected: false, clientId: '1-a.apps.googleusercontent.com' });
    await yt.remove(two[1].id);
    expect(await make(file).list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts).toHaveLength(1);
  });

  it('importar chaves: o mesmo canal é atualizado no lugar, canal novo é somado', async () => {
    const yt = make(join(dir(), 'youtube.json'));
    await yt.importPortable([{ id: 'principal', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'velho', channel: { id: 'UC1', title: 'Canal A', thumbnail: null } }]);
    const ids = await yt.merge([
      { id: 'xyz', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'novo', channel: { id: 'UC1', title: 'Canal A', thumbnail: null } },
      { id: 'principal', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'b', channel: { id: 'UC2', title: 'Canal B', thumbnail: null } },
    ]);
    expect(ids.get('xyz')).toBe('principal');
    const list = await yt.list();
    expect(list.map((a) => a.channel?.title)).toEqual(['Canal A', 'Canal B']);
    expect(list[1].id).not.toBe('principal');
    expect((await yt.exportPortable())[0].refreshToken).toBe('novo');
  });
});
