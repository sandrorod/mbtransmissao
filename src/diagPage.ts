/** Diagnóstico (OBS_E2E=pagina): a página do widget atualiza em tempo real? Página local que muda 20x/s. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runPageDiag(): Promise<void> {
  const report: Record<string, unknown> = {};
  try {
    const { pool, pageRegistry } = await import('./devices/pool');
    const page = { id: 'relogio', name: 'Relógio', url: 'http://127.0.0.1:8599/relogio.html', width: 1280, height: 720, region: null, chroma: { enabled: false, color: '#00ff00', similarity: 0.25, smoothness: 0.08 } };
    pageRegistry.set(page.id, page);
    const key = pool.acquire({ kind: 'video', deviceId: 'pagina:relogio', label: 'Relógio', constraints: {} });
    for (let i = 0; i < 75 && pool.get(key)?.status === 'abrindo'; i++) await wait(200);
    const track = pool.get(key)?.stream?.getVideoTracks()[0];
    if (!track) throw new Error(`página: ${pool.get(key)?.error}`);
    report.trilha = track.getSettings();
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    Object.assign(video.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', opacity: '0.01' });
    document.body.appendChild(video);
    await video.play();
    let frames = 0;
    const tick = () => { frames++; video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
    // Conteúdo diferente de verdade: amostra a faixa da barra vermelha a cada 50 ms e conta mudanças.
    const c = document.createElement('canvas');
    c.width = 128; c.height = 8;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    let last = '';
    let changes = 0;
    const sampler = setInterval(() => {
      if (!video.videoWidth) return;
      g.drawImage(video, 0, video.videoHeight * 0.86, video.videoWidth, video.videoHeight * 0.05, 0, 0, 128, 8);
      const d = g.getImageData(0, 4, 128, 1).data;
      let sig = '';
      for (let i = 0; i < 128; i++) sig += d[i * 4] > 200 && d[i * 4 + 1] < 80 ? '1' : '0';
      if (sig !== last) { changes++; last = sig; }
    }, 50);
    const porSegundo: string[] = [];
    const total = 360; const step = 30;
    for (let s = 0; s < total; s += step) {
      const f0 = frames, c0 = changes;
      await wait(step * 1000);
      porSegundo.push(`${s}-${s + step}s: ${Math.round((frames - f0) / step)} quadros/s, ${Math.round((changes - c0) / step)} mudanças/s`);
    }
    clearInterval(sampler);
    report.medicao = porSegundo;
    report.ok = true;
  } catch (e) {
    report.erro = e instanceof Error ? e.message : String(e);
  }
  await window.studio.reportSelfTest(report);
}
