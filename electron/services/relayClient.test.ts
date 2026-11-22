import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PhoneServer } from './phoneServer';
import { relayBase, relayPathAllowed, RelayClient } from './relayClient';
import type { PhoneEvent } from '../../src/types/studio';

const SECRET = 'chave-de-teste-1234567890';
const RELAY_PORT = 18700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${RELAY_PORT}`;
const events: PhoneEvent[] = [];
const dir = mkdtempSync(join(tmpdir(), 'relay-'));
const phones = new PhoneServer(join(dir, 'celular.json'), (e) => events.push(e));
let relayProc: ChildProcess;
let client: RelayClient;

const wait = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  await phones.start(18443);
  phones.setStudioReady();
  relayProc = spawn(process.execPath, [join(__dirname, '../../camera-relay/server.mjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(RELAY_PORT), RELAY_SECRET: SECRET }, stdio: 'ignore' });
  await wait(() => false, 0).catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/saude`)).ok) break; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  client = new RelayClient(async () => ({ base, secret: SECRET }), () => phones.certificate, () => undefined, () => undefined);
  await client.start(phones.port);
  await wait(() => client.state.state === 'ligado');
});

afterAll(() => {
  client?.stop();
  phones.stop();
  relayProc?.kill();
});

describe('ponte do domínio próprio (camera-relay)', () => {
  it('serve a página do celular pelo servidor', async () => {
    const page = await fetch(`${base}/c/${phones.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await page.text()).toContain('Compartilhar câmera');
    const js = await fetch(`${base}/celular.js`);
    expect(await js.text()).toContain('estudio-celular-id');
  });

  it('celular entra, manda sinal e recebe mensagem do Estúdio pela consulta longa', async () => {
    const id = 'celular-teste-0001';
    const first = await fetch(`${base}/c/${phones.token}/espera?id=${id}&nome=Quadra`).then((r) => r.json());
    expect(first).toEqual([{ t: 'pronto' }]);
    expect(events.some((e) => e.t === 'entrou' && e.id === id)).toBe(true);
    const sent = await fetch(`${base}/c/${phones.token}/enviar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, t: 'sinal', dados: { sdp: 'x' } }) });
    expect(sent.status).toBe(204);
    expect(events.some((e) => e.t === 'sinal' && e.id === id)).toBe(true);
    const waiting = fetch(`${base}/c/${phones.token}/espera?id=${id}&nome=Quadra`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 300));
    phones.send(id, { t: 'no-ar', on: true });
    expect(await waiting).toEqual([{ t: 'no-ar', on: true }]);
  });

  it('recusa código errado, rotas fora do celular e chave errada', async () => {
    expect((await fetch(`${base}/c/codigo-errado-123`)).status).toBe(404);
    expect((await fetch(`${base}/r/qualquer`)).status).toBe(404);
    expect((await fetch(`${base}/_estudio/espera`, { headers: { 'x-estudio-chave': 'errada-errada-errada' } })).status).toBe(401);
    expect(relayPathAllowed('/r/abc')).toBe(false);
    expect(relayPathAllowed('/c/abcdefghijkl/espera?id=1')).toBe(true);
    expect(relayBase('http://camera.x.com')).toBeNull();
    expect(relayBase('https://camera.x.com/')).toBe('https://camera.x.com');
  });
});
