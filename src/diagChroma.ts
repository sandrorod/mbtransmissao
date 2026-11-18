/** Diagnóstico do chroma (OBS_E2E=chroma): página local verde com quadrado vermelho, por cima de um fundo azul. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runChromaDiag(): Promise<void> {
  const report: Record<string, unknown> = {};
  try {
    const { pool, pageRegistry } = await import('./devices/pool');
    const { Compositor } = await import('./program/compositor');
    const url = 'http://127.0.0.1:8599/';
    const page = { id: 'croma', name: 'Croma', url, width: 1280, height: 720, region: null, chroma: { enabled: true, color: '#00ff00', similarity: 0.25, smoothness: 0.08 } };
    pageRegistry.set(page.id, page);
    const key = pool.acquire({ kind: 'video', deviceId: 'pagina:croma', label: 'Croma', constraints: {} });
    for (let i = 0; i < 75 && pool.get(key)?.status === 'abrindo'; i++) await wait(200);
    const track = pool.get(key)?.stream?.getVideoTracks()[0];
    if (!track) throw new Error(`página: ${pool.get(key)?.error}`);
    // Fundo azul como outra camada (como uma câmera embaixo do widget).
    const blue = document.createElement('canvas');
    blue.width = 1280; blue.height = 720;
    const bg = blue.getContext('2d')!;
    const t = setInterval(() => { bg.fillStyle = '#0000ff'; bg.fillRect(0, 0, 1280, 720); bg.fillStyle = '#0000fe'; bg.fillRect(0, 0, 2, 2); }, 33);
    const blueTrack = blue.captureStream(30).getVideoTracks()[0];
    const comp = new Compositor(1280, 720, 30);
    comp.setLayers([
      { id: 'azul', track: blueTrack, settings: undefined, transform: null, hidden: false },
      { id: 'pag', track, settings: undefined, transform: null, hidden: false, chroma: page.chroma },
    ]);
    comp.start();
    await wait(4000);
    const g = comp.canvas.getContext('2d')!;
    const px = (x: number, y: number) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
    report.fundoVerde = px(100, 100); // deve ficar azul (transparente)
    report.quadradoVermelho = px(640, 360); // deve continuar vermelho
    report.semChroma = await (async () => {
      comp.setLayers([
        { id: 'azul', track: blueTrack, settings: undefined, transform: null, hidden: false },
        { id: 'pag', track, settings: undefined, transform: null, hidden: false, chroma: null },
      ]);
      await wait(1500);
      return px(100, 100);
    })();
    clearInterval(t);
    report.ok = true;
  } catch (e) {
    report.erro = e instanceof Error ? e.message : String(e);
  }
  await window.studio.reportSelfTest(report);
}
