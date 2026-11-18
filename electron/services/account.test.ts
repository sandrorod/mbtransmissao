import { describe, expect, it } from 'vitest';
import { CloudAccount, explainAuth, TABLE, type StoredSession } from './account';

const config = { url: 'https://x.supabase.co', anonKey: 'anon' };
const tokens = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600, user: { id: 'u1', email: 'a@b.com' } };

function fakeServer(routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new TypeError('fetch failed');
    const r = routes[key](init);
    return new Response(r.body === null ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function memoryStore(initial: StoredSession | null = null) {
  let value = initial;
  return { read: async () => value, write: async (s: StoredSession | null) => { value = s; }, get: () => value };
}

describe('conta do Estúdio', () => {
  it('entra, guarda só o token de renovação (nunca a senha) e lê/grava a própria linha', async () => {
    const store = memoryStore();
    let saved: unknown = null;
    const { fetcher, calls } = fakeServer({
      'grant_type=password': () => ({ status: 200, body: tokens }),
      [`/rest/v1/${TABLE}?on_conflict`]: (init) => { saved = JSON.parse(String(init.body)); return { status: 201, body: null }; },
      [`/rest/v1/${TABLE}?select`]: () => ({ status: 200, body: [{ data: { preferences: 1, project: 2, destinations: [], youtube: null }, updated_at: '2026-01-01T00:00:00Z', device: 'mac' }] }),
    });
    const cloud = new CloudAccount(config, store, fetcher);
    expect(await cloud.login(' A@B.com ', '123456')).toEqual({ userId: 'u1', email: 'a@b.com' });
    expect(store.get()).toEqual({ userId: 'u1', email: 'a@b.com', refreshToken: 'ref' });
    expect(JSON.stringify(store.get())).not.toContain('123456');
    await cloud.push({ preferences: {}, project: {}, destinations: [], youtube: null }, 'mac');
    expect(saved).toMatchObject({ user_id: 'u1', device: 'mac' });
    expect((await cloud.pull())?.data.project).toBe(2);
    const rest = calls.find((c) => c.url.includes('select'))!;
    expect(rest.url).toContain('user_id=eq.u1');
    expect((rest.init.headers as Record<string, string>).Authorization).toBe('Bearer acc');
  });

  it('senha errada e conta repetida viram mensagens claras', () => {
    expect(explainAuth(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })).toBe('E-mail ou senha incorretos.');
    expect(explainAuth(422, { error_code: 'user_already_exists' })).toMatch(/Já existe/);
  });

  it('sem internet entra com o que está salvo no Mac; sessão recusada pede login de novo', async () => {
    const saved = { userId: 'u1', email: 'a@b.com', refreshToken: 'ref' };
    const offline = new CloudAccount(config, memoryStore(saved), fakeServer({}).fetcher);
    expect(await offline.restore()).toEqual({ userId: 'u1', email: 'a@b.com', offline: true });
    const store = memoryStore(saved);
    const revoked = new CloudAccount(config, store, fakeServer({ refresh_token: () => ({ status: 400, body: { error_code: 'refresh_token_not_found' } }) }).fetcher);
    expect(await revoked.restore()).toBeNull();
    expect(store.get()).toBeNull();
  });

  it('sem servidor configurado não tenta entrar', async () => {
    const cloud = new CloudAccount(null, memoryStore());
    expect(cloud.configured).toBe(false);
    await expect(cloud.login('a@b.com', 'x')).rejects.toThrow(/não foi configurado/);
  });
});
