import { LevelMeter } from './audio/engine';
import { audioType, isAliasDevice, videoType } from './devices/identify';
import { MediaPool } from './devices/mediaPool';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Conta quadros reais entregues pela câmera durante um tempo. */
async function countFrames(stream: MediaStream, ms: number): Promise<{ frames: number; width: number; height: number; blackish: boolean }> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();
  let frames = 0;
  const started = performance.now();
  // Páginas paradas só geram quadro quando mudam: a contagem tem prazo e não espera para sempre.
  await new Promise<void>((resolve) => {
    const done = setTimeout(resolve, ms + 500);
    const tick = () => {
      frames++;
      if (performance.now() - started < ms) video.requestVideoFrameCallback(tick);
      else {
        clearTimeout(done);
        resolve();
      }
    };
    video.requestVideoFrameCallback(tick);
  });
  // Confere que a imagem não é um quadro preto/congelado vazio.
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 36;
  const g = canvas.getContext('2d')!;
  g.drawImage(video, 0, 0, 64, 36);
  const pixels = g.getImageData(0, 0, 64, 36).data;
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
  const result = { frames, width: video.videoWidth, height: video.videoHeight, blackish: sum / (pixels.length / 4) / 3 < 4 };
  video.remove();
  return result;
}

async function measureLevel(stream: MediaStream, ms: number): Promise<{ peakDb: number; samples: number }> {
  const meter = new LevelMeter(stream);
  let peak = -Infinity;
  let samples = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    peak = Math.max(peak, meter.peak());
    samples++;
    await wait(20);
  }
  meter.dispose();
  return { peakDb: Number.isFinite(peak) ? Math.round(peak * 10) / 10 : -999, samples };
}

const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function runSelfTest(): Promise<void> {
  const api = window.studio;
  const report: Record<string, unknown> = { quando: new Date().toISOString(), agente: navigator.userAgent };
  try {
    report.permissoes = await api.mediaAccess();
    report.avfoundation = await api.listNativeDevices();

    // Destrava os nomes (o Chromium esconde sem uma captura autorizada).
    for (const c of [{ video: true }, { audio: true }] as MediaStreamConstraints[]) {
      try { (await navigator.mediaDevices.getUserMedia(c)).getTracks().forEach((t) => t.stop()); } catch (e) { report[`destravar_${Object.keys(c)[0]}`] = errorText(e); }
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter((d) => d.kind === 'videoinput');
    const mics = all.filter((d) => d.kind === 'audioinput' && !isAliasDevice(d.deviceId));
    report.dispositivos = all.map((d) => ({ tipo: d.kind, nome: d.label, id: d.deviceId.slice(0, 10) }));

    const video: unknown[] = [];
    for (const cam of cams) {
      const item: Record<string, unknown> = { nome: cam.label, tipo: videoType(cam.label) };
      item.modosAVFoundation = await api.probeVideoModes(cam.label);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId } } });
        const track = stream.getVideoTracks()[0];
        item.capacidades = (({ width, height, frameRate }) => ({ width, height, frameRate }))(track.getCapabilities());
        item.imagem = await countFrames(stream, 2000);
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        item.erro = errorText(e);
      }
      video.push(item);
    }
    report.video = video;

    const audio: unknown[] = [];
    for (const mic of mics) {
      const item: Record<string, unknown> = { nome: mic.label, tipo: audioType(mic.label) };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: mic.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const track = stream.getAudioTracks()[0];
        const caps = track.getCapabilities() as MediaTrackCapabilities & { channelCount?: unknown; sampleRate?: unknown };
        item.capacidades = { canais: caps.channelCount, frequencia: caps.sampleRate, filtros: { eco: caps.echoCancellation, ruido: caps.noiseSuppression, ganho: caps.autoGainControl } };
        item.config = track.getSettings();
        item.nivel = await measureLevel(stream, 1500);
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        item.erro = errorText(e);
      }
      audio.push(item);
    }
    report.audio = audio;

    // Áudio e vídeo juntos, pelo mesmo pool do app; duas "cenas" pedindo a mesma câmera abrem uma vez só.
    const realCam = cams.find((c) => videoType(c.label) !== 'Câmera virtual') ?? cams[0];
    if (realCam && mics[0]) {
      const pool = new MediaPool((c) => navigator.mediaDevices.getUserMedia(c), {}, 0);
      const spec = { kind: 'video' as const, deviceId: realCam.deviceId, label: realCam.label, constraints: {} };
      const sceneA = pool.acquire(spec);
      const sceneB = pool.acquire(spec);
      const mic = pool.acquire({ kind: 'audio', deviceId: mics[0].deviceId, label: mics[0].label, constraints: { echoCancellation: false } });
      for (let i = 0; i < 100 && pool.list().some((e) => e.status === 'abrindo'); i++) await wait(50);
      const camEntry = pool.get(sceneA)!;
      const micEntry = pool.get(mic)!;
      const [imagem, nivel] = await Promise.all([
        camEntry.stream ? countFrames(camEntry.stream, 2000) : Promise.resolve(null),
        micEntry.stream ? measureLevel(micEntry.stream, 2000) : Promise.resolve(null),
      ]);
      report.simultaneo = {
        camera: realCam.label,
        microfone: mics[0].label,
        mesmaCapturaNasDuasCenas: sceneA === sceneB,
        aberturasDeDispositivo: pool.opens,
        statusCamera: camEntry.status,
        statusMicrofone: micEntry.status,
        imagem,
        nivel,
      };
      // Fecha uma "cena": a outra continua com imagem.
      pool.release(sceneB);
      report.simultaneo = { ...(report.simultaneo as object), depoisDeFecharUmaCena: pool.get(sceneA)?.status ?? 'fechado' };
      pool.dispose();
    }
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.erroGeral = errorText(e);
  }
  await api.reportSelfTest(report);
}

declare global {
  interface Window {
    studioTest: { openPhone(url: string): Promise<void>; phoneStatus(): Promise<string | null> };
  }
}

async function until<T>(check: () => T | null | undefined | false, ms: number, step = 200): Promise<T | null> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = check();
    if (value) return value;
    await wait(step);
  }
  return null;
}

/**
 * Ponta a ponta com as peças reais do app: celular (página servida pelo Estúdio, HTTPS, WebRTC),
 * página da web capturada, compositor do programa e transmissão para um servidor RTMP local.
 */
export async function runE2E(): Promise<void> {
  const api = window.studio;
  const report: Record<string, unknown> = { quando: new Date().toISOString() };
  const { phones } = await import('./phone/phones');
  const { pool, pageRegistry } = await import('./devices/pool');
  const { Compositor } = await import('./program/compositor');
  const { LiveController } = await import('./program/live');
  const { mixer } = await import('./audio/engine');
  const probe = async (label: string, track: MediaStreamTrack) => {
    let bytes = 0;
    const rec = new MediaRecorder(new MediaStream([track]), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => { bytes += e.data.size; };
    rec.start(250);
    await wait(3000);
    rec.stop();
    await wait(400);
    track.stop();
    return `${label}: ${Math.round(bytes / 1024)} KB em 3 s`;
  };
  const plain = () => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d')!;
    let n = 0;
    const t = setInterval(() => { g.fillStyle = `hsl(${(n++ * 7) % 360},60%,40%)`; g.fillRect(0, 0, 1280, 720); }, 33);
    const track = c.captureStream(30).getVideoTracks()[0];
    track.addEventListener('ended', () => clearInterval(t));
    return track;
  };
  const probes: string[] = [];
  report.gravador = probes;
  try {
    probes.push(await probe('canvas simples, antes de tudo', plain()));
    // 1. Celular entra pelo link (mesmo caminho do QR Code).
    await phones.start();
    const link = await api.phoneLink();
    report.link = { rodando: link.running, porta: link.port, enderecos: link.urls.length, erro: link.error };
    const url = link.urls[0]?.replace(/https:\/\/[^:/]+/, 'https://127.0.0.1') ?? '';
    await window.studioTest.openPhone(url);
    const phoneDevice = await until(() => phones.devices().find((d) => d.kind === 'videoinput'), 20000);
    report.celularNaLista = phoneDevice ? { nome: phoneDevice.label, id: phoneDevice.deviceId.slice(0, 20) } : null;
    report.celularAudio = phones.devices().some((d) => d.kind === 'audioinput');
    report.statusNoCelular = await window.studioTest.phoneStatus();
    await wait(5000);
    report.recepcaoCelular = phones.list()[0]?.stats ?? null;

    // 2. Fonte do celular pelo pool + página da web.
    const phoneKey = phoneDevice ? pool.acquire({ kind: 'video', deviceId: phoneDevice.deviceId, label: phoneDevice.label, constraints: {} }) : null;
    const page = { id: 'teste', name: 'Página de teste', url: 'https://example.com/', width: 1280, height: 720, region: null, chroma: { enabled: true, color: '#ffffff', similarity: 0.2, smoothness: 0.05 } };
    pageRegistry.set(page.id, page);
    const pageKey = pool.acquire({ kind: 'video', deviceId: 'pagina:teste', label: page.name, constraints: {} });
    await until(() => pool.list().every((e) => e.status !== 'abrindo'), 15000);
    const phoneStream = phoneKey ? pool.get(phoneKey)?.stream ?? null : null;
    const pageStream = pool.get(pageKey)?.stream ?? null;
    report.imagemCelular = phoneStream ? await countFrames(phoneStream, 1500) : pool.get(phoneKey ?? '')?.error ?? 'sem stream';
    report.imagemPagina = pageStream ? await countFrames(pageStream, 1500) : pool.get(pageKey)?.error ?? 'sem stream';
    if (!pageStream) {
      try {
        const id = await api.openPage(page);
        const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } as unknown as MediaTrackConstraints });
        report.paginaDireto = { ok: true, tracks: s.getTracks().length, id: id.slice(0, 12) };
      } catch (e) {
        report.paginaDireto = { erro: errorText(e) };
      }
    }

    // 3. Compositor: celular em tela cheia + página num quadro cortado no canto.
    const compositor = new Compositor(1920, 1080, 30);
    const video = (s: MediaStream | null) => s?.getVideoTracks()[0] ?? null;
    compositor.setLayers([
      { id: 'cel', track: video(phoneStream), settings: undefined, transform: null, hidden: false },
      { id: 'pag', track: video(pageStream), settings: undefined, transform: { x: 0.6, y: 0.05, w: 0.35, crop: { l: 0, t: 0, r: 0, b: 0 } }, hidden: false, region: { x: 0.2, y: 0.2, w: 0.6, h: 0.4 }, chroma: page.chroma },
    ]);
    const problemas: string[] = [];
    compositor.onProblem = (m) => problemas.push(m);
    report.problemasDoCompositor = problemas;
    compositor.start();
    await wait(1500);
    const comChroma = { ms: Math.round(compositor.drawMs * 10) / 10, quadros: compositor.drawnFps };
    compositor.setLayers(compositor['layers'].map((l: { chroma?: unknown }) => ({ ...l, chroma: null })) as never);
    await wait(1500);
    report.tempoDeDesenho = { comChroma, semChroma: { ms: Math.round(compositor.drawMs * 10) / 10, quadros: compositor.drawnFps } };
    probes.push(await probe('canvas simples, com compositor (sem chroma)', plain()));
    compositor.setLayers(compositor['layers'].map((l: { chroma?: unknown }) => ({ ...l, chroma: page.chroma })) as never);
    await wait(1000);
    probes.push(await probe('canvas simples, com chroma ligado', plain()));
    const f0 = compositor.outputFrames;
    probes.push(await probe('trilha do programa (gerador)', compositor.outputTrack(30, 'gerador')));
    probes.push(`  gerador entregou ${Math.round((compositor.outputFrames - f0) / 3)} quadros/s`);
    probes.push(await probe('trilha do programa (captura do canvas)', compositor.outputTrack(30, 'canvas')));
    compositor.stop();
    (compositor as unknown as { fps: number }).fps = 15;
    compositor.start();
    await wait(500);
    probes.push(await probe('captura do canvas, compositor a 30/s', compositor.outputTrack(30, 'canvas')));
    const f1 = compositor.outputFrames;
    probes.push(await probe('gerador, compositor a 30/s', compositor.outputTrack(30, 'gerador')));
    probes.push(`  gerador entregou ${Math.round((compositor.outputFrames - f1) / 3)} quadros/s`);
    compositor.stop();
    (compositor as unknown as { fps: number }).fps = 30;
    compositor.start();
    const g = compositor.canvas.getContext('2d')!;
    const corner = [...g.getImageData(Math.round(1280 * 0.75), Math.round(720 * 0.12), 1, 1).data];
    report.compositor = { tamanho: [compositor.canvas.width, compositor.canvas.height], pixelNaPagina: corner, camadasComImagem: [...compositor.sizes.keys()], quadrosNovosPorSegundo: compositor.drawnFps };

    // 4. Transmissão real para um RTMP local + um destino fora do ar (não pode derrubar o primeiro).
    await api.saveDestination({ platform: 'custom', name: 'RTMP local', server: 'rtmp://127.0.0.1:19350/live', key: 'chave-secreta-123', enabled: true });
    await api.saveDestination({ platform: 'custom', name: 'Fora do ar', server: 'rtmp://127.0.0.1:19399/live', key: 'outra-chave-456', enabled: true });
    const listed = await api.listDestinations();
    report.destinosNaTela = listed.map((d) => ({ nome: d.name, dica: d.keyHint, temChave: JSON.stringify(d).includes('chave-secreta') }));
    const statuses: unknown[] = [];
    const live = new LiveController((fps, method) => compositor.outputTrack(fps, method), () => mixer.programStream().getAudioTracks(), (s) => statuses.push(s), { frames: () => compositor.outputFrames, failures: () => compositor.outputFailures, drawn: () => compositor.drawnFps, rebuild: () => compositor.rebuildCanvas() });
    await live.start({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' });
    await wait(8000);
    await live.stop();
    await wait(1500);
    const all = JSON.stringify(statuses);
    const last = statuses.filter((s) => (s as { state: string }).state !== 'parado').at(-1) as Record<string, unknown> | undefined;
    report.transmissao = {
      estados: [...new Set(statuses.map((s) => (s as { state: string }).state))],
      ultimo: last ? { fps: last.fps, kbps: last.kbps, destinos: last.destinations } : null,
      chaveVazouNaTela: all.includes('chave-secreta-123') || all.includes('outra-chave-456'),
    };

    // 4b. A falha relatada: o vídeo do programa para de sair. A autocorreção precisa trocar de formato e entrar no ar.
    const stalled: unknown[] = [];
    let calls = 0;
    const broken = new LiveController((fps, method) => {
      calls++;
      if (calls === 1) {
        // Trilha que nunca entrega quadro (como o gravador travado no seu Mac).
        const Gen = (window as unknown as { MediaStreamTrackGenerator: new (i: { kind: 'video' }) => MediaStreamTrack }).MediaStreamTrackGenerator;
        return new Gen({ kind: 'video' });
      }
      return compositor.outputTrack(fps, method);
    }, () => mixer.programStream().getAudioTracks(), (st) => stalled.push(st), { frames: () => compositor.outputFrames, failures: () => compositor.outputFailures, drawn: () => compositor.drawnFps, rebuild: () => compositor.rebuildCanvas() });
    await broken.start({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' });
    await until(() => stalled.some((st) => (st as { state: string }).state === 'ao-vivo'), 40000, 500);
    await broken.stop();
    await wait(1500);
    report.autocorrecao = {
      estados: [...new Set(stalled.map((st) => (st as { state: string }).state))],
      mensagens: [...new Set(stalled.map((st) => (st as { message?: string }).message).filter(Boolean))],
      trilhasCriadas: calls,
      registro: (await api.readLiveLog()).split('\n').filter((l) => l.includes('tela:') || l.includes('estado:')).map((l) => l.slice(25, 170)),
    };

    // 5. Remover o celular: ele é avisado e sai da lista.
    if (phoneDevice) {
      phones.remove(phoneDevice.deviceId.split(':')[1]);
      await wait(1500);
      report.depoisDeRemover = { naLista: phones.devices().length, statusNoCelular: await window.studioTest.phoneStatus() };
    }
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.erroGeral = errorText(e);
  }
  await api.reportSelfTest(report);
}
