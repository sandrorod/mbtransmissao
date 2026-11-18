import { describe, expect, it } from 'vitest';
import { openKeys, sealKeys } from './keyFile';

describe('arquivo de chaves', () => {
  const data = { youtube: [{ id: 'principal', clientId: 'x.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'r' }], destinations: [{ id: 'd1', key: 'abcd-1234' }] };

  it('abre com a senha certa e devolve exatamente o que foi guardado', () => {
    const file = sealKeys(data, 'senha-forte');
    expect(file).not.toContain('abcd-1234');
    expect(file).not.toContain('googleusercontent');
    expect(openKeys(file, 'senha-forte')).toEqual(data);
  });

  it('recusa senha errada, arquivo alterado, outro tipo de arquivo e senha curta', () => {
    const file = sealKeys(data, 'senha-forte');
    expect(() => openKeys(file, 'outra-senha')).toThrow(/Senha incorreta/);
    const parsed = JSON.parse(file);
    parsed.data = Buffer.from('x' + Buffer.from(parsed.data, 'base64').toString('binary'), 'binary').toString('base64');
    expect(() => openKeys(JSON.stringify(parsed), 'senha-forte')).toThrow(/Senha incorreta|alterado/);
    expect(() => openKeys('{"kind":"estudio-layout"}', 'senha-forte')).toThrow(/não é um arquivo de chaves/);
    expect(() => sealKeys(data, '123')).toThrow(/pelo menos 6/);
  });
});
