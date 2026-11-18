import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoogleDrive } from './googleDrive';

const vault = { encrypt: (t: string) => `enc:${t}`, decrypt: (d: string) => d.replace(/^enc:/, '') };

function fakeGoogle() {
  const calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
  let folders: { id: string; name: string }[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body, headers: init?.headers as Record<string, string> });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'AT', expires_in: 3600 });
    if (url.includes('/drive/v3/files?q=')) return json(200, { files: folders.filter((f) => decodeURIComponent(url).includes(`name='${f.name}'`)) });
    if (url.includes('/drive/v3/files?fields=id') && method === 'POST') {
      const f = { id: `pasta${folders.length + 1}`, name: JSON.parse(String(init!.body)).name };
      folders.push(f);
      return json(200, { id: f.id });
    }
    if (url.includes('uploadType=resumable')) {
      const meta = JSON.parse(String(init!.body));
      if (meta.name.startsWith('falha')) return json(403, { error: { message: 'proibido' } });
      return json(200, {}, { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=X' });
    }
    if (url.includes('upload_id=X') && method === 'PUT') return json(200, { id: 'arq1', webViewLink: 'https://drive.google.com/file/d/arq1/view' });
    return json(404, { error: { message: 'não simulado' } });
  }) as typeof fetch;
  return { calls, fetchFn, reset: () => { folders = []; } };
}

describe('Google Drive', () => {
  it('envia para a pasta do Estúdio (criada uma vez) e um arquivo que falha não impede os outros', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-'));
    const file = join(dir, 'google-drive.json');
    writeFileSync(file, JSON.stringify({ clientId: '1-a.apps.googleusercontent.com', clientSecretEnc: 'enc:GOCSPX-x', refreshTokenEnc: 'enc:RT', email: 'x@y', folderName: 'Replays do Jogo', folderId: null }));
    const video = join(dir, 'replay-1700000000000-15s.mp4');
    writeFileSync(video, Buffer.alloc(1000, 1));
    const g = fakeGoogle();
    const drive = new GoogleDrive({ file, vault, fetch: g.fetchFn, openBrowser: () => undefined });
    const progress: string[] = [];
    const results = await drive.upload([{ path: video, name: 'Replay 1.mp4' }, { path: video, name: 'falha.mp4' }], (d, t) => progress.push(`${d}/${t}`));
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[0].link).toContain('drive.google.com');
    expect(results[1].error).toMatch(/proibido/);
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    const create = g.calls.filter((c) => c.method === 'POST' && c.url.includes('/drive/v3/files?fields=id'));
    expect(create).toHaveLength(1);
    const put = g.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers?.['Content-Length']).toBe('1000');
    // Segunda vez: a pasta guardada é reaproveitada (não cria outra).
    await drive.upload([{ path: video, name: 'Replay 2.mp4' }], () => undefined);
    expect(g.calls.filter((c) => c.method === 'POST' && c.url.includes('/drive/v3/files?fields=id'))).toHaveLength(1);
  });

  it('replay numa pasta do Estúdio vai para uma pasta com o mesmo nome dentro da pasta principal (criada uma vez)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-'));
    const file = join(dir, 'google-drive.json');
    writeFileSync(file, JSON.stringify({ clientId: '1-a.apps.googleusercontent.com', clientSecretEnc: 'enc:GOCSPX-x', refreshTokenEnc: 'enc:RT', email: null, folderName: 'Replays', folderId: null }));
    const video = join(dir, 'replay-1700000000000-15s.mp4');
    writeFileSync(video, Buffer.alloc(10, 1));
    const g = fakeGoogle();
    const drive = new GoogleDrive({ file, vault, fetch: g.fetchFn, openBrowser: () => undefined });
    const results = await drive.upload([
      { path: video, name: 'A.mp4', folder: 'Jogo 1' },
      { path: video, name: 'B.mp4', folder: 'Jogo 1' },
      { path: video, name: 'C.mp4', folder: null },
    ], () => undefined);
    expect(results.every((r) => r.ok)).toBe(true);
    const created = g.calls.filter((c) => c.method === 'POST' && c.url.includes('/drive/v3/files?fields=id')).map((c) => JSON.parse(String(c.body)));
    expect(created).toEqual([
      { name: 'Replays', mimeType: 'application/vnd.google-apps.folder' },
      { name: 'Jogo 1', mimeType: 'application/vnd.google-apps.folder', parents: ['pasta1'] },
    ]);
    const parents = g.calls.filter((c) => c.url.includes('uploadType=resumable')).map((c) => JSON.parse(String(c.body)).parents[0]);
    expect(parents).toEqual(['pasta2', 'pasta2', 'pasta1']);
  });

  it('sem conta conectada pede para conectar em Configurações', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gd-')), 'google-drive.json');
    const drive = new GoogleDrive({ file, vault, fetch: fakeGoogle().fetchFn, openBrowser: () => undefined });
    await drive.setClient('1-a.apps.googleusercontent.com', 'GOCSPX-segredo123');
    await expect(drive.upload([{ path: '/x', name: 'a' }], () => undefined)).rejects.toThrow(/Configurações › Google Drive/);
  });
});
