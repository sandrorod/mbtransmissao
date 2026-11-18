/**
 * Diagnóstico do gravador da transmissão (OBS_E2E=gravador): mede, combinação por combinação,
 * quantos bytes o MediaRecorder entrega. Conteúdo com ruído, para a contagem de bytes significar algo.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Gen = MediaStreamTrack & { writable: WritableStream<VideoFrame> };

function noisyCanvas(w = 1280, h = 720): { canvas: HTMLCanvasElement; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  let n = 0;
  const t = setInterval(() => {
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsl(${Math.random() * 360},70%,50%)`;
      g.fillRect(Math.random() * w, Math.random() * h, 80, 80);
    }
    g.fillStyle = '#000';
    g.fillRect(0, 0, 200, 50);
    g.fillStyle = '#fff';
    g.font = '32px sans-serif';
    g.fillText(String(n++), 10, 40);
  }, 33);
  return { canvas, stop: () => clearInterval(t) };
}

function generatorFrom(canvas: HTMLCanvasElement, fps = 30): { track: MediaStreamTrack; written: () => number; stop: () => void } {
  const Ctor = (window as unknown as { MediaStreamTrackGenerator: new (i: { kind: 'video' }) => Gen }).MediaStreamTrackGenerator;
  const gen = new Ctor({ kind: 'video' });
  const writer = gen.writable.getWriter();
  const t0 = performance.now();
  let written = 0;
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    const frame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - t0) * 1000) });
    busy = true;
    writer.write(frame).then(() => written++).catch(() => frame.close()).finally(() => { busy = false; });
  }, 1000 / fps);
  return { track: gen, written: () => written, stop: () => { clearInterval(t); gen.stop(); } };
}

async function record(track: MediaStreamTrack, mimeType: string, ms = 3000, audio: MediaStreamTrack[] = []): Promise<{ kb: number; pedacos: number }> {
  let bytes = 0;
  let chunks = 0;
  const rec = new MediaRecorder(new MediaStream([track, ...audio]), { mimeType, videoBitsPerSecond: 12_000_000 });
  rec.ondataavailable = (e) => {
    bytes += e.data.size;
    if (e.data.size) chunks++;
  };
  rec.start(250);
  await wait(ms);
  rec.stop();
  await wait(400);
  return { kb: Math.round(bytes / 1024), pedacos: chunks };
}

const VP8 = 'video/webm;codecs=vp8';
const H264 = 'video/x-matroska;codecs=avc1';

export async function runRecorderDiag(): Promise<void> {
  const report: Record<string, unknown> = { quando: new Date().toISOString(), visivel: document.visibilityState };
  const results: Record<string, unknown> = {};
  report.resultados = results;
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      results[label] = await fn();
    } catch (e) {
      results[label] = `ERRO: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  try {
    await run('A canvas.captureStream vp8', async () => {
      const c = noisyCanvas();
      const r = await record(c.canvas.captureStream(30).getVideoTracks()[0], VP8);
      c.stop();
      return r;
    });
    await run('B gerador vp8', async () => {
      const c = noisyCanvas();
      const g = generatorFrom(c.canvas);
      const r = await record(g.track, VP8);
      const out = { ...r, quadrosEscritos: g.written() };
      g.stop();
      c.stop();
      return out;
    });
    await run('C gerador h264 matroska', async () => {
      const c = noisyCanvas();
      const g = generatorFrom(c.canvas);
      const r = await record(g.track, H264);
      const out = { ...r, quadrosEscritos: g.written() };
      g.stop();
      c.stop();
      return out;
    });
    await run('D gerador 1920x1080 h264', async () => {
      const c = noisyCanvas(1920, 1080);
      const g = generatorFrom(c.canvas);
      const r = await record(g.track, H264);
      const out = { ...r, quadrosEscritos: g.written() };
      g.stop();
      c.stop();
      return out;
    });

    // Vídeo + áudio, como na transmissão: o gravador espera o áudio para soltar o vídeo?
    const withAudio = (label: string, audio: () => MediaStreamTrack[], mime = 'video/x-matroska;codecs=avc1,opus') => run(label, async () => {
      const c = noisyCanvas(1920, 1080);
      const g = generatorFrom(c.canvas);
      const tracks = audio();
      const r = await record(g.track, mime, 3000, tracks);
      const out = { ...r, quadrosEscritos: g.written(), audio: tracks.map((t) => `${t.readyState}${t.muted ? ' mudo' : ''}`) };
      g.stop();
      c.stop();
      return out;
    });
    const { mixer, audioClock } = await import('./audio/engine');
    const t0 = audioClock();
    await wait(500);
    results['S0 relógio do áudio'] = { antes: t0, depois: audioClock() };
    await withAudio('S1 h264 + áudio do programa', () => mixer.programStream().getAudioTracks());
    await withAudio('S2 vp8 + áudio do programa', () => mixer.programStream().getAudioTracks(), 'video/webm;codecs=vp8,opus');
    await withAudio('S3 h264 + tom de teste (contexto novo)', () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream.getAudioTracks();
    });

    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    const camTrack = cam.getVideoTracks()[0];
    await run('E câmera direto vp8', () => record(camTrack.clone(), VP8));

    const { Compositor } = await import('./program/compositor');
    const comp = new Compositor(1920, 1080, 30);
    comp.setLayers([{ id: 'cam', track: camTrack, settings: undefined, transform: null, hidden: false }]);
    comp.start();
    await wait(1500);
    report.compositor = { quadrosNovosPorSegundo: comp.drawnFps, msPorDesenho: Math.round(comp.drawMs * 10) / 10 };
    await run('F compositor outputTrack h264', async () => {
      const t = comp.outputTrack(30);
      const r = await record(t, H264);
      t.stop();
      return r;
    });
    await run('G compositor outputTrack vp8', async () => {
      const t = comp.outputTrack(30);
      const r = await record(t, VP8);
      t.stop();
      return r;
    });
    await run('H compositor captureStream vp8', async () => {
      const t = comp.canvas.captureStream(30).getVideoTracks()[0];
      const r = await record(t, VP8);
      t.stop();
      return r;
    });
    await run('I gerador vp8 com compositor rodando', async () => {
      const c = noisyCanvas();
      const g = generatorFrom(c.canvas);
      const r = await record(g.track, VP8);
      const out = { ...r, quadrosEscritos: g.written() };
      g.stop();
      c.stop();
      return out;
    });
    comp.stop();
    comp.setLayers([]);
    await wait(500);
    await run('J gerador vp8 depois de parar o compositor', async () => {
      const c = noisyCanvas();
      const g = generatorFrom(c.canvas);
      const r = await record(g.track, VP8);
      const out = { ...r, quadrosEscritos: g.written() };
      g.stop();
      c.stop();
      return out;
    });
    cam.getTracks().forEach((t) => t.stop());

    // Fontes que só o teste completo usa: página capturada, celular (WebRTC), chroma.
    const { phones } = await import('./phone/phones');
    const { pool, pageRegistry } = await import('./devices/pool');
    const page = { id: 'teste', name: 'Página', url: 'https://example.com/', width: 1280, height: 720, region: null, chroma: { enabled: true, color: '#ffffff', similarity: 0.2, smoothness: 0.05 } };
    pageRegistry.set(page.id, page);
    const pageKey = pool.acquire({ kind: 'video', deviceId: 'pagina:teste', label: page.name, constraints: {} });
    const until = async <T,>(f: () => T | null | undefined | false, ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { const v = f(); if (v) return v; await wait(200); } return null; };
    await until(() => pool.get(pageKey)?.status !== 'abrindo', 15000);
    const pageTrack = pool.get(pageKey)?.stream?.getVideoTracks()[0] ?? null;
    report.pagina = pageTrack ? pageTrack.getSettings() : pool.get(pageKey)?.error;
    const withLayers = async (label: string, layers: Parameters<typeof comp.setLayers>[0]) => {
      const c2 = new Compositor(1920, 1080, 30);
      c2.setLayers(layers);
      c2.start();
      await wait(1500);
      await run(label, async () => {
        const t = c2.outputTrack(30);
        const r = await record(t, H264);
        t.stop();
        return { ...r, quadrosNovosPorSegundo: c2.drawnFps, ms: Math.round(c2.drawMs * 10) / 10 };
      });
      c2.stop();
      c2.setLayers([]);
    };
    if (pageTrack) {
      await withLayers('K página (sem chroma)', [{ id: 'pag', track: pageTrack, settings: undefined, transform: null, hidden: false }]);
      await withLayers('L página com chroma', [{ id: 'pag', track: pageTrack, settings: undefined, transform: null, hidden: false, chroma: page.chroma }]);
      await withLayers('M página com área + chroma', [{ id: 'pag', track: pageTrack, settings: undefined, transform: { x: 0.6, y: 0.05, w: 0.35, crop: { l: 0, t: 0, r: 0, b: 0 } }, hidden: false, region: { x: 0.2, y: 0.2, w: 0.6, h: 0.4 }, chroma: page.chroma }]);
    }
    await phones.start();
    const link = await window.studio.phoneLink();
    const url = link.urls[0]?.replace(/https:\/\/[^:/]+/, 'https://127.0.0.1') ?? '';
    await window.studioTest.openPhone(url);
    const phoneDevice = await until(() => phones.devices().find((d) => d.kind === 'videoinput'), 20000);
    if (phoneDevice) {
      const phoneKey = pool.acquire({ kind: 'video', deviceId: phoneDevice.deviceId, label: phoneDevice.label, constraints: {} });
      await until(() => pool.get(phoneKey)?.status !== 'abrindo', 15000);
      const phoneTrack = pool.get(phoneKey)?.stream?.getVideoTracks()[0] ?? null;
      report.celular = phoneTrack?.getSettings() ?? pool.get(phoneKey)?.error;
      if (phoneTrack) {
        await run('N celular direto h264', () => record(phoneTrack.clone(), H264));
        await withLayers('O compositor só celular', [{ id: 'cel', track: phoneTrack, settings: undefined, transform: null, hidden: false }]);
        if (pageTrack) await withLayers('Q celular + página sem chroma', [
          { id: 'cel', track: phoneTrack, settings: undefined, transform: null, hidden: false },
          { id: 'pag', track: pageTrack, settings: undefined, transform: { x: 0.6, y: 0.05, w: 0.35, crop: { l: 0, t: 0, r: 0, b: 0 } }, hidden: false, region: { x: 0.2, y: 0.2, w: 0.6, h: 0.4 } },
        ]);
        if (pageTrack) await withLayers('P celular + página com chroma', [
          { id: 'cel', track: phoneTrack, settings: undefined, transform: null, hidden: false },
          { id: 'pag', track: pageTrack, settings: undefined, transform: { x: 0.6, y: 0.05, w: 0.35, crop: { l: 0, t: 0, r: 0, b: 0 } }, hidden: false, region: { x: 0.2, y: 0.2, w: 0.6, h: 0.4 }, chroma: page.chroma },
        ]);
        await withLayers('R celular de novo, no fim', [{ id: 'cel', track: phoneTrack, settings: undefined, transform: null, hidden: false }]);
      }
    } else report.celular = 'não entrou';
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.erro = e instanceof Error ? e.message : String(e);
  }
  await window.studio.reportSelfTest(report);
}
