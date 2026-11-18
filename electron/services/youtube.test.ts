import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YoutubeAccount } from './youtube';

const vault = { encrypt: (t: string) => `enc(${t})`, decrypt: (d: string) => d.replace(/^enc\((.*)\)$/, '$1') };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Google de mentira: registra cada pedido e responde como a API real. */
function fakeGoogle() {
  const calls: { method: string; url: string; body: string; auth: string | null }[] = [];
  let streams: unknown[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : '';
    const auth = new Headers(init?.headers).get('Authorization');
    calls.push({ method: init?.method ?? 'GET', url, body, auth });
    if (url.includes('oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') return json(200, { access_token: 'acesso-1', expires_in: 3600, refresh_token: 'renovar-1' });
      return json(200, { access_token: 'acesso-2', expires_in: 3600 });
    }
    if (url.includes('/channels?')) return json(200, { items: [{ id: 'UC1', snippet: { title: 'Mais Basquete', thumbnails: { default: { url: 'https://x/a.jpg' } } } }] });
    if (url.includes('liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=upcoming')) {
      return json(200, { items: [{ id: 'b-futuro', snippet: { title: 'Final', description: '', scheduledStartTime: '2026-11-20T22:00:00Z' }, status: { lifeCycleStatus: 'ready', privacyStatus: 'public' } }] });
    }
    if (url.includes('broadcastStatus=active')) return json(200, { items: [] });
    if (url.endsWith('liveBroadcasts?part=snippet,status,contentDetails') && init?.method === 'POST') return json(200, { id: 'b-novo' });
    if (url.includes('liveStreams?part=snippet,cdn&mine=true')) return json(200, { items: streams });
    if (url.includes('liveStreams?part=snippet,cdn,contentDetails') && init?.method === 'POST') {
      const created = { id: 's1', snippet: { title: 'Estúdio ao Vivo' }, cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2', streamName: 'abcd-efgh-ijkl' } } };
      streams = [created];
      return json(200, created);
    }
    if (url.includes('liveBroadcasts/bind')) return json(200, { snippet: { title: 'Final' } });
    return json(404, { error: { message: 'não simulado' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const account = (fetchFn: typeof fetch, openBrowser: (url: string) => void = () => undefined) =>
  new YoutubeAccount({ file: join(mkdtempSync(join(tmpdir(), 'yt-')), 'youtube.json'), vault, fetch: fetchFn, openBrowser });

describe('conta do YouTube', () => {
  it('confere as credenciais do cliente OAuth', async () => {
    const yt = account(fakeGoogle().fetchFn);
    await expect(yt.setClient('abc', 'segredo-1234567')).rejects.toThrow(/apps\.googleusercontent\.com/);
    const state = await yt.setClient('123-abc.apps.googleusercontent.com', 'GOCSPX-segredo123');
    expect(state).toMatchObject({ configured: true, connected: false });
  });

  it('login pelo navegador com PKCE, retorno em 127.0.0.1 e token guardado criptografado', async () => {
    const google = fakeGoogle();
    let authUrl = '';
    // "Navegador": abre o endereço do Google e devolve o código no endereço local, como o Google faz.
    const browser = async (url: string) => {
      authUrl = url;
      const u = new URL(url);
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'codigo-123');
      back.searchParams.set('state', u.searchParams.get('state')!);
      await fetch(back);
    };
    const yt = account(google.fetchFn, browser);
    await yt.setClient('123-abc.apps.googleusercontent.com', 'GOCSPX-segredo123');
    const state = await yt.connect(10_000);
    expect(state).toMatchObject({ connected: true, channel: { title: 'Mais Basquete' } });
    const params = new URL(authUrl).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('https://www.googleapis.com/auth/youtube');
    expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const exchange = new URLSearchParams(google.calls.find((c) => c.url.includes('/token'))!.body);
    expect(exchange.get('code')).toBe('codigo-123');
    expect(exchange.get('code_verifier')).toHaveLength(64);
    expect(exchange.get('client_secret')).toBe('GOCSPX-segredo123');
  });

  it('lista as lives programadas, cria uma nova e liga a chave do Estúdio', async () => {
    const google = fakeGoogle();
    const yt = account(google.fetchFn, async (url) => {
      const u = new URL(url);
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'c');
      back.searchParams.set('state', u.searchParams.get('state')!);
      await fetch(back);
    });
    await yt.setClient('123-abc.apps.googleusercontent.com', 'GOCSPX-segredo123');
    await yt.connect(10_000);

    const list = await yt.broadcasts();
    expect(list.map((b) => [b.id, b.title, b.status])).toEqual([['b-futuro', 'Final', 'ready']]);

    await yt.create({ title: 'Semifinal', description: 'Ao vivo', scheduledStart: '2026-11-15T20:00:00-03:00', privacy: 'unlisted' });
    const insert = JSON.parse(google.calls.find((c) => c.method === 'POST' && c.url.endsWith('liveBroadcasts?part=snippet,status,contentDetails'))!.body);
    expect(insert.snippet).toMatchObject({ title: 'Semifinal', scheduledStartTime: '2026-11-15T23:00:00.000Z' });
    expect(insert.contentDetails).toMatchObject({ enableAutoStart: true, enableAutoStop: false });
    expect(insert.status.privacyStatus).toBe('unlisted');

    // Sem stream no canal: cria o "Estúdio ao Vivo" reutilizável e liga à live.
    const first = await yt.prepare('b-futuro');
    expect(first).toEqual({ server: 'rtmps://a.rtmps.youtube.com/live2', key: 'abcd-efgh-ijkl', title: 'Final' });
    // Na segunda vez reaproveita o mesmo stream (a chave não muda).
    await yt.prepare('b-novo');
    expect(google.calls.filter((c) => c.method === 'POST' && c.url.includes('liveStreams')).length).toBe(1);
    expect(google.calls.filter((c) => c.url.includes('/bind')).map((c) => new URL(c.url).searchParams.get('id'))).toEqual(['b-futuro', 'b-novo']);
    // Toda chamada à API vai com o token de acesso.
    expect(google.calls.filter((c) => c.url.includes('/youtube/v3/')).every((c) => c.auth === 'Bearer acesso-1')).toBe(true);
  });

  it('explica os erros do YouTube em português', async () => {
    const yt = account((async (input: RequestInfo | URL) => (String(input).includes('/token')
      ? json(200, { access_token: 'a', expires_in: 3600, refresh_token: 'r' })
      : json(403, { error: { message: 'x', errors: [{ reason: 'liveStreamingNotEnabled' }] } }))) as typeof fetch, async (url) => {
      const u = new URL(url);
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'c');
      back.searchParams.set('state', u.searchParams.get('state')!);
      await fetch(back);
    });
    await yt.setClient('123-abc.apps.googleusercontent.com', 'GOCSPX-segredo123');
    await expect(yt.connect(10_000)).rejects.toThrow(/ainda não pode transmitir ao vivo/);
  });
});
