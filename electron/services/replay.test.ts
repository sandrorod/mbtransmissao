import { describe, expect, it } from 'vitest';
import { parseClip, pickSegments, validClipId } from './replay';

describe('replay', () => {
  const now = 100_000;
  // Pedaços de 1 s; cada um termina na hora em que foi gravado (o último ainda está sendo escrito).
  const files = Array.from({ length: 20 }, (_, i) => ({ name: `seg${String(i).padStart(6, '0')}.ts`, mtimeMs: now - (19 - i) * 1000, size: 1000 }));
  it('pega os pedaços que cobrem os últimos N segundos (nunca menos)', () => {
    const chosen = pickSegments(files, now, 7000);
    expect(chosen[0]).toBe('seg000013.ts');
    expect(chosen.at(-1)).toBe('seg000019.ts');
    // O pedaço anterior ao primeiro termina no começo dos 7 s.
    expect(files[12].mtimeMs).toBeLessThanOrEqual(now - 7000);
  });
  it('ignora arquivos vazios e estranhos', () => {
    expect(pickSegments([...files.map((f) => ({ ...f, size: 0 })), { name: 'x.ts', mtimeMs: now, size: 9 }], now, 7000)).toEqual([]);
  });
  it('só aceita nomes de replay gerados pelo app', () => {
    expect(validClipId('replay-1794531118053-7s.mp4')).toBe(true);
    expect(validClipId('../../etc/passwd')).toBe(false);
    expect(validClipId('replay-1-7s.mp4/../x')).toBe(false);
    expect(parseClip('replay-1794531118053-15s.mp4', 10)).toEqual({ id: 'replay-1794531118053-15s.mp4', createdAt: 1794531118053, seconds: 15, bytes: 10 });
  });
});

describe('dados do replay', () => {
  it('só aceita campos conhecidos e corte válido', async () => {
    const { cleanPatch, cleanFolders } = await import('./replay');
    expect(cleanPatch({ name: '  Cesta  ', hack: 1, start: 2.04, end: 9 })).toEqual({ name: 'Cesta', start: 2, end: 9 });
    expect(cleanPatch({ start: 5, end: 3 })).toEqual({ start: 5, end: null });
    expect(cleanPatch({ folder: 7 })).toEqual({ folder: null });
    expect(cleanFolders([{ id: 'a', name: 'Primeiro tempo' }, { id: 'b', name: '' }, 'x'])).toEqual([{ id: 'a', name: 'Primeiro tempo', collapsed: false }]);
  });
});

describe('replay das câmeras', () => {
  it('arquivo da câmera usa o mesmo corte do programa', async () => {
    const { cameraArgs, validCamKey } = await import('./replay');
    expect(validClipId('replay-1700000000000-15s-c1a2b3.mp4')).toBe(true);
    expect(validClipId('replay-1700000000000-15s-../x.mp4')).toBe(false);
    expect(parseClip('replay-1700000000000-15s-c1a2b3.mp4', 10)).toMatchObject({ createdAt: 1700000000000, seconds: 15 });
    expect(validCamKey('c1a2b3')).toBe(true);
    expect(validCamKey('../x')).toBe(false);
    const copy = cameraArgs('webm', true, '/tmp/c');
    expect(copy).toContain('copy');
    expect(copy).toContain('-an');
    expect(cameraArgs('webm', false, '/tmp/c')).toContain('h264_videotoolbox');
  });
});

describe('corte do replay pelo tempo do vídeo', () => {
  it('sai com o tempo pedido mesmo quando o FFmpeg gravou atrasado (pedaços todos recentes)', async () => {
    const { mkdtempSync, utimesSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const ffmpeg = (await import('ffmpeg-static')).default as unknown as string;
    const { ReplayStore } = await import('./replay');
    const root = mkdtempSync(join(tmpdir(), 'rp-'));
    const store = new ReplayStore(join(root, 'buffer'), join(root, 'replays'), ffmpeg);
    const dir = await store.begin(1);
    // 20 s de vídeo com keyframe a cada 1 s, em pedaços de 1 s (como a transmissão grava).
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', join(dir, 'seg%06d.ts')]);
    // Atraso: todos os pedaços terminaram de ser escritos nos últimos 4 s de relógio.
    const now = Date.now();
    const segs = readdirSync(dir).sort();
    segs.forEach((n, i) => { const t = (now - 4000 + (i * 4000) / segs.length) / 1000; utimesSync(join(dir, n), t, t); });
    const clips = await store.cut(7);
    const out = join(root, 'replays', clips[0].id);
    const info = (() => { try { execFileSync(ffmpeg, ['-hide_banner', '-i', out]); return ''; } catch (e) { return String((e as { stderr: Buffer }).stderr); } })();
    const [, h, m, sec] = /Duration: (\d+):(\d+):([\d.]+)/.exec(info)!;
    const duration = Number(h) * 3600 + Number(m) * 60 + Number(sec);
    expect(duration).toBeGreaterThanOrEqual(6.9);
    expect(duration).toBeLessThanOrEqual(8.2);
    expect(readdirSync(join(root, 'replays')).filter((n) => n.includes('inteiro'))).toEqual([]);
    await store.end();
  }, 60000);
});

describe('replay logo depois de começar a transmissão', () => {
  it('com só 3 s gravados, diz 3 s (nome do arquivo e lista), nunca o tempo pedido', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const ffmpeg = (await import('ffmpeg-static')).default as unknown as string;
    const { ReplayStore } = await import('./replay');
    const root = mkdtempSync(join(tmpdir(), 'rp-'));
    const store = new ReplayStore(join(root, 'buffer'), join(root, 'replays'), ffmpeg);
    const dir = await store.begin(1);
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', join(dir, 'seg%06d.ts')]);
    const [clip] = await store.cut(7);
    expect(clip.seconds).toBe(3);
    expect(clip.id).toMatch(/-3s\.mp4$/);
    expect((await store.list()).map((c) => c.seconds)).toEqual([3]);
    await store.end();
  }, 60000);
});
