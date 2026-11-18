import { BrowserWindow, session, type WebContents } from 'electron';
import { validPageUrl } from '../../src/utils/validate';
import type { PageScroll, WebPage } from '../../src/types/studio';

const PARTITION = 'persist:paginas-da-web';
const windows = new Map<string, { window: BrowserWindow; url: string; timer: ReturnType<typeof setInterval>; scroll: PageScroll | null }>();

/** Esconde as barras de rolagem: elas não devem aparecer na transmissão (a rolagem é feita pelo Estúdio). */
const HIDE_SCROLLBARS = '::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; } html, body { scrollbar-width: none !important; }';

/**
 * Placar do StatCourt (maxscore): o "Comentário destaque" do YouTube entra deslizando por cima da página
 * (fixo no rodapé nas páginas 1, 3 e 4) e caía dentro dos widgets. Nos widgets ele nunca aparece.
 * O quadro é a linha que começa com o avatar redondo de 72 px com borda de 3 px.
 */
const SCOREBOARD_HOSTS = ['maxscore.maisbasquete.com.br'];
const HIDE_FEATURED_COMMENT = [
  'div[style*="position: fixed"][style*="bottom: 8vh"]',
  'div:has(> div[style*="width: 72px"][style*="height: 72px"][style*="border-radius: 50%"][style*="3px solid"])',
].join(',\n') + ' { visibility: hidden !important; opacity: 0 !important; }';

export const isScoreboard = (url: string) => {
  try {
    return SCOREBOARD_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * Script que acha o que rola no ponto (x, y) — a própria página ou uma caixa com rolagem dentro dela
 * (placares costumam rolar dentro de uma div) — e lê ou aplica a posição.
 */
const SCROLLER = (x: number, y: number) => `(() => {
  let el = document.elementFromPoint(${x}, ${y});
  while (el && el !== document.documentElement) {
    const s = getComputedStyle(el);
    if ((el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(s.overflowY)) || (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll|overlay)/.test(s.overflowX))) return el;
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
})()`;

async function readScroll(window: BrowserWindow, x: number, y: number): Promise<PageScroll | null> {
  if (window.isDestroyed()) return null;
  const pos = await window.webContents.executeJavaScript(`(() => { const el = ${SCROLLER(x, y)}; return { top: el.scrollTop, left: el.scrollLeft }; })()`).catch(() => null) as { top: number; left: number } | null;
  return pos ? { x, y, top: Math.round(pos.top), left: Math.round(pos.left) } : null;
}

/** Leva a página à posição guardada (pode repetir: é uma posição, não um "rolar mais"). */
function applyScroll(window: BrowserWindow, scroll: PageScroll | null): void {
  if (!scroll || window.isDestroyed()) return;
  void window.webContents.executeJavaScript(`(() => { const el = ${SCROLLER(scroll.x, scroll.y)}; el.scrollTop = ${scroll.top}; el.scrollLeft = ${scroll.left}; })()`).catch(() => undefined);
}

/** Rola a página como a rodinha do mouse no ponto (x, y) e devolve a nova posição (para guardar no widget). */
export async function scrollPage(id: string, x: number, y: number, dx: number, dy: number): Promise<PageScroll | null> {
  const entry = windows.get(id);
  if (!entry || entry.window.isDestroyed()) return null;
  const px = Math.round(x);
  const py = Math.round(y);
  const wc = entry.window.webContents;
  const before = await readScroll(entry.window, px, py);
  await wc.executeJavaScript(`(() => { const el = ${SCROLLER(px, py)}; el.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' }); })()`).catch(() => undefined);
  let pos = await readScroll(entry.window, px, py);
  if (before && pos && before.top === pos.top && before.left === pos.left) {
    // Nada rolou pelo script (página com overflow escondido, rolagem própria em JS, iframe…):
    // manda uma rodinha de verdade no ponto, como se o mouse estivesse sobre a página.
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    wc.sendInputEvent({ type: 'mouseWheel', x: px, y: py, deltaX: -dx, deltaY: -dy, canScroll: true } as Electron.MouseWheelInputEvent);
    await new Promise((r) => setTimeout(r, 80));
    wc.invalidate();
    pos = (await readScroll(entry.window, px, py)) ?? pos;
  }
  entry.scroll = pos;
  return pos;
}
let configured = false;

/**
 * As páginas rodam isoladas do app: sem câmera, microfone, notificações, downloads nem janelas novas.
 * A única permissão aceita é "display-capture", que o Chromium pede à própria página quando o Estúdio
 * a captura. Se a página tentar capturar a tela do Mac (getDisplayMedia), o pedido é recusado abaixo.
 */
function configureSession(): void {
  if (configured) return;
  configured = true;
  const s = session.fromPartition(PARTITION);
  // As páginas se apresentam como um Chrome comum: o nome do app ("Estúdio", com acento) no User-Agent
  // fazia servidores responderem erro 500 a todas as consultas (placar ficava em "CARREGANDO...").
  s.setUserAgent(s.getUserAgent().replace(/\s*\S*(?:Est\S*dio|Electron)\S*/gi, '').replace(/[^\x20-\x7E]/g, ''));
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'display-capture'));
  s.setPermissionCheckHandler(() => false);
  s.setDisplayMediaRequestHandler((_request, callback) => {
    try {
      callback({});
    } catch {
      // Resposta vazia = recusado.
    }
  });
  s.on('will-download', (event) => event.preventDefault());
  if (process.env.OBS_PAGE_DEBUG) {
    s.webRequest.onErrorOccurred((d) => console.log(`[página rede] ${d.error} ${d.url.slice(0, 140)}`));
    s.webRequest.onCompleted((d) => { if (d.statusCode >= 400 || /supabase|rest|realtime|api/.test(d.url)) console.log(`[página rede] ${d.statusCode} ${d.method} ${d.url.slice(0, 140)}`); });
  }
}

/**
 * Abre a página numa janela escondida, do tamanho pedido, e devolve o id para capturá-la como vídeo
 * na tela do Estúdio. Se já estiver aberta, só ajusta endereço e tamanho.
 */
export async function openPage(page: WebPage, requester: WebContents): Promise<string> {
  if (!validPageUrl(page.url)) throw new Error('Endereço inválido: use um link que comece com https:// ou http://.');
  configureSession();
  let entry = windows.get(page.id);
  if (!entry || entry.window.isDestroyed()) {
    const window = new BrowserWindow({
      show: false,
      width: page.width,
      height: page.height,
      useContentSize: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      // autoplayPolicy: a página toca som sem ninguém clicar nela (ela nunca recebe clique, fica escondida).
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true, autoplayPolicy: 'no-user-gesture-required' },
    });
    // Muda só no alto-falante do Mac: o som continua indo para a captura (canal do widget no mixer).
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Sempre ao vivo: se a página não carregar (internet oscilou) ou travar/cair, recarrega sozinha.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const reloadSoon = (ms: number, why: string) => {
      if (retry) return;
      console.log(`[página] ${page.url.slice(0, 60)}: recarregando em ${ms} ms (${why})`);
      retry = setTimeout(() => {
        retry = null;
        if (!window.isDestroyed()) window.webContents.reloadIgnoringCache();
      }, ms);
    };
    window.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      // -3 = carregamento cancelado (troca de endereço): não é falha.
      if (isMainFrame && code !== -3) reloadSoon(5000, `falha ${code}`);
    });
    window.webContents.on('render-process-gone', (_e, d) => reloadSoon(1000, `processo caiu: ${d.reason}`));
    window.webContents.on('unresponsive', () => reloadSoon(10000, 'sem resposta'));
    window.webContents.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) console.log(`[página] navegando: ${d.url.slice(0, 80)}`); });
    if (process.env.OBS_PAGE_DEBUG) {
      window.webContents.on('console-message', (e) => console.log(`[página console] ${String((e as unknown as { message: string }).message).slice(0, 300)}`));
    }
    // Ao (re)carregar: sem barras de rolagem e de volta à posição guardada. Repete porque páginas que
    // montam o conteúdo depois (React) ainda não têm altura para rolar logo que carregam.
    window.webContents.on('did-finish-load', () => {
      void window.webContents.insertCSS(HIDE_SCROLLBARS).catch(() => undefined);
      if (isScoreboard(window.webContents.getURL())) void window.webContents.insertCSS(HIDE_FEATURED_COMMENT).catch(() => undefined);
      for (const ms of [0, 1500, 4000, 8000]) setTimeout(() => applyScroll(window, windows.get(page.id)?.scroll ?? null), ms);
    });
    window.webContents.on('responsive', () => {
      if (retry) clearTimeout(retry);
      retry = null;
    });
    window.on('closed', () => { if (retry) clearTimeout(retry); });
    // Página parada não gera quadro novo; redesenhar de vez em quando garante imagem na captura.
    const timer = setInterval(() => {
      if (!window.isDestroyed()) window.webContents.invalidate();
    }, 1000);
    entry = { window, url: '', timer, scroll: page.scroll ?? null };
    windows.set(page.id, entry);
  }
  const [w, h] = entry.window.getContentSize();
  if (w !== page.width || h !== page.height) entry.window.setContentSize(page.width, page.height);
  const scroll = page.scroll ?? null;
  if (JSON.stringify(scroll) !== JSON.stringify(entry.scroll)) {
    entry.scroll = scroll;
    applyScroll(entry.window, scroll);
  }
  if (entry.url !== page.url) {
    entry.url = page.url;
    // Não espera a página terminar de carregar: a imagem aparece assim que ela desenhar.
    entry.window.loadURL(page.url).catch(() => undefined);
  }
  return entry.window.webContents.getMediaSourceId(requester);
}

export function reloadPage(id: string): void {
  windows.get(id)?.window.webContents.reloadIgnoringCache();
}

export function closePage(id: string): void {
  const entry = windows.get(id);
  windows.delete(id);
  if (entry) clearInterval(entry.timer);
  if (entry && !entry.window.isDestroyed()) entry.window.destroy();
}

export function closeAllPages(): void {
  for (const id of [...windows.keys()]) closePage(id);
}
