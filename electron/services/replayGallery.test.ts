import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { PhoneServer } from './phoneServer';
import { GalleryEvents, handleGallery, type GallerySource } from './replayGallery';
import type { ReplayClip } from '../../src/types/studio';

const dir = mkdtempSync(join(tmpdir(), 'rg-'));
const A = 'replay-1700000000000-15s.mp4';
const B = 'replay-1700000100000-10s.mp4';
writeFileSync(join(dir, A), Buffer.from('0123456789abcdef'));
writeFileSync(join(dir, B), Buffer.from('xyz'));
const clips: ReplayClip[] = [
  { id: B, createdAt: 1700000100000, seconds: 10, bytes: 3, name: 'Cesta do Pedro', folder: 'f1', note: 'contra-ataque' },
  { id: A, createdAt: 1700000000000, seconds: 15, bytes: 16, folder: null, start: 2, end: 9 },
];
const source: GallerySource = { list: async () => clips, folders: async () => [{ id: 'f1', name: 'Jogo 1', collapsed: false }], path: (id) => join(dir, id) };

const server = new PhoneServer(join(dir, 'celular.json'), () => undefined);
server.gallery = (rest, url, req, res) => handleGallery(source, rest, url, req, res);
afterAll(() => server.stop());

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers, rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('página dos replays', () => {
  it('só abre com o link secreto e lista pastas e replays com os nomes do Estúdio', async () => {
    await server.start(19443);
    const t = server.replayToken;
    expect(t.length).toBeGreaterThan(20);
    expect((await get('/r/errado/lista')).status).toBe(404);
    expect((await get(`/r/${t.slice(0, -1)}x/lista`)).status).toBe(404);
    // Link sem a barra no fim vai para o endereço com barra (senão o script não carrega).
    const bare = await get(`/r/${t}`);
    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe(`/r/${t}/`);
    const page = await get(`/r/${t}/`);
    expect(page.status).toBe(200);
    const script = new URL('app.js', `https://x/r/${t}/`).pathname;
    expect((await get(script)).status).toBe(200);
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'self'");
    const list = JSON.parse((await get(`/r/${t}/lista`)).body.toString());
    expect(list.folders).toEqual([{ id: 'f1', name: 'Jogo 1' }]);
    expect(list.clips.map((c: { name: string; folder: string | null }) => [c.name, c.folder])).toEqual([['Cesta do Pedro', 'f1'], ['Replay 1', null]]);
    expect(list.clips[1]).toMatchObject({ start: 2, end: 9 });
  });

  it('entrega o vídeo por partes (avançar/voltar) e baixa com o nome do replay', async () => {
    const t = server.replayToken;
    const part = await get(`/r/${t}/v/${A}`, { Range: 'bytes=4-7' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 4-7/16');
    expect(part.body.toString()).toBe('4567');
    const all = await get(`/r/${t}/v/${A}`);
    expect(all.body.toString()).toBe('0123456789abcdef');
    const dl = await get(`/r/${t}/v/${B}?baixar=1`);
    expect(String(dl.headers['content-disposition'])).toContain('Cesta do Pedro.mp4');
    expect((await get(`/r/${t}/v/..%2Fcelular.json`)).status).toBe(404);
    expect((await get(`/r/${t}/v/${A}`, { Range: 'bytes=99-' })).status).toBe(416);
  });

  it('link novo: o antigo para de funcionar', async () => {
    const old = server.replayToken;
    await server.newReplayToken();
    expect((await get(`/r/${old}/lista`)).status).toBe(404);
    expect((await get(`/r/${server.replayToken}/lista`)).status).toBe(200);
  });
});

describe('página com a pasta do Drive', () => {
  it('lista a pasta do projeto no Drive e entrega o vídeo do Drive passando pelo Estúdio', async () => {
    const calls: (string | undefined)[] = [];
    const driveSource: GallerySource = {
      ...source,
      drive: {
        list: async () => ({ project: 'rm x sp', url: 'https://drive.google.com/drive/folders/PASTA', groups: [{ name: 'Jogo 1', videos: [{ id: 'arquivo1234567', name: 'Replay 1', bytes: 10, createdAt: 1, seconds: 7 }] }, { name: null, videos: [] }] }),
        stream: async (_id, range) => { calls.push(range); return new Response('abcd', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'content-length': '4' } }); },
      },
    };
    const srv = new PhoneServer(join(dir, 'celular2.json'), () => undefined);
    srv.gallery = (rest, url, req, res) => handleGallery(driveSource, rest, url, req, res);
    await srv.start(19480);
    const t = srv.replayToken;
    const req = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: srv.port, path, headers, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      r.on('error', reject);
      r.end();
    });
    const listing = JSON.parse((await req(`/r/${t}/drive`)).body);
    expect(listing).toMatchObject({ available: true, project: 'rm x sp', url: 'https://drive.google.com/drive/folders/PASTA' });
    expect(listing.groups[0].videos[0].name).toBe('Replay 1');
    const v = await req(`/r/${t}/d/arquivo1234567?baixar=1&nome=Replay%201`, { Range: 'bytes=0-3' });
    expect(v.status).toBe(206);
    expect(v.body).toBe('abcd');
    expect(v.headers['content-range']).toBe('bytes 0-3/10');
    expect(String(v.headers['content-disposition'])).toContain('Replay 1.mp4');
    expect(calls).toEqual(['bytes=0-3']);
    expect((await req(`/r/${t}/d/../../x`)).status).toBe(404);
    srv.stop();
  });

  it('sem Drive conectado, avisa a página (que mostra os replays deste computador)', async () => {
    let body = '';
    const res = { writeHead: () => res, end: (b: string) => { body = b; } } as never;
    await handleGallery({ ...source, drive: { list: async () => null, stream: async () => new Response(null) } }, ['drive'], new URL('https://x/'), { method: 'GET', headers: {} } as never, res);
    expect(JSON.parse(body)).toEqual({ available: false, error: null });
  });
});

describe('atualização em tempo real', () => {
  it('a página aberta recebe o aviso logo depois de uma mudança (vários avisos seguidos viram um)', async () => {
    const events = new GalleryEvents();
    const srv = new PhoneServer(join(dir, 'celular3.json'), () => undefined);
    srv.gallery = (rest, url, req, res) => handleGallery({ ...source, events }, rest, url, req, res);
    await srv.start(19520);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: srv.port, path: `/r/${srv.replayToken}/eventos`, rejectUnauthorized: false }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          received.push(c);
          if (received.join('').includes('data: mudou')) { r.destroy(); resolve(); }
        });
        // Conectou: três mudanças seguidas.
        setTimeout(() => { events.changed(); events.changed(); events.changed(); }, 50);
      });
      r.on('error', (e) => (received.join('').includes('mudou') ? resolve() : reject(e)));
      r.end();
    });
    expect(received.join('').match(/data: mudou/g)).toHaveLength(1);
    srv.stop();
  });
});

describe('script da página', () => {
  it('compila sem erro de sintaxe', async () => {
    let body = '';
    const res = { writeHead: () => res, end: (b: string) => { body = b; } } as never;
    await handleGallery(source, ['app.js'], new URL('https://x/'), { method: 'GET', headers: {} } as never, res);
    expect(() => new Function(body)).not.toThrow();
    expect(body).toContain("replace(/\\/+$/, '')");
  });
});
