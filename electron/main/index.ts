import { existsSync, mkdtempSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences } from 'electron';
import { hudOf, layout as validLayout, layoutFile, validatePreferences, validateProject } from '../../src/utils/validate';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, accountOfDestination, isYoutubeDestination, youtubeDestinationId, type KeysImportResult, type LayoutFile, type MediaAccess, type Preferences, type WindowState } from '../../src/types/studio';
import { IPC } from '../../src/types/ipc';
import { forgetVideoModes, listNativeDevices, probeVideoModes } from '../services/avfoundation';
import { DestinationStore } from '../services/destinations';
import type { YoutubeAccount } from '../services/youtube';
import { YoutubeAccounts } from '../services/youtubeAccounts';
import { openKeys, sealKeys } from '../services/keyFile';
import { GoogleDrive } from '../services/googleDrive';
import { GalleryEvents, handleGallery } from '../services/replayGallery';
import { Sessions } from '../services/sessions';
import { clipName } from '../../src/utils/replayNames';
import { CloudAccount, type CloudData, type StoredSession } from '../services/account';
import { CLOUD } from '../services/cloudConfig';
import { FFMPEG, LiveSession } from '../services/live';
import { ReplayStore, validCamKey, validClipId } from '../services/replay';
import { openTlsTunnel, type Tunnel } from '../services/tlsTunnel';
import { ENDED, endedMessage, liveMessage } from '../services/youtubeStatus';
import { LiveExtrasWatcher } from '../services/liveExtras';
import { closeAllPages, closePage, openPage, reloadPage, scrollPage } from '../services/pages';
import { lanAddresses, PhoneServer, type IceServer } from '../services/phoneServer';
import { RemoteTunnel } from '../services/remoteTunnel';
import { MediaFiles, registerMediaScheme } from '../services/mediaFiles';
import { output as validOutput, validPageUrl } from '../../src/utils/validate';
import type { PhoneLink, WebPage } from '../../src/types/studio';

const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const SELF_TEST = process.env.OBS_SELFTEST ?? null;
/**
 * Teste de ponta a ponta: um "celular" (janela que abre o link, com a câmera do Mac), página e transmissão local.
 * Sem a câmera falsa do Chromium: ela impede a captura de páginas.
 */
const E2E = process.env.OBS_E2E === '1' || process.env.OBS_E2E === 'gravador';
// A transmissão não pode depender de a janela estar visível: atrás do navegador (vendo a live) ou
// minimizada, o macOS a marca como oculta e o Chromium reduzia o trabalho dela; o gravador do programa
// parava de entregar vídeo (0 KB/s) e a live congelava até cair.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (process.env.OBS_DATA_DIR) app.setPath('userData', process.env.OBS_DATA_DIR);
if (SELF_TEST) {
  // Autotestes nunca tocam no projeto, nas preferências nem nas chaves do operador.
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'estudio-teste-')));
}
let mainWindow: BrowserWindow | null = null;
let phones: PhoneServer | null = null;
let tunnel: RemoteTunnel | null = null;
let e2ePhone: BrowserWindow | null = null;
let destinations: DestinationStore | null = null;
let youtube: YoutubeAccounts | null = null;
let drive: GoogleDrive | null = null;
let live: LiveSession | null = null;
let tunnels: Tunnel[] = [];
/** Acompanha a situação da live no YouTube enquanto transmite. */
let youtubeWatch: ReturnType<typeof setInterval> | null = null;
/**
 * Registro de diagnóstico. Fora de uma transmissão vai para <dados do app>/inicio.log (abertura do app,
 * busca de câmeras); durante a transmissão passa a ser o transmissao.log.
 */
let liveLog: (line: string) => void = (line) =>
  void appendFile(join(app.getPath('userData'), 'inicio.log'), `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => undefined);
/** Número da sessão atual: pedaços de vídeo de uma sessão anterior (ainda na fila) são descartados. */
let liveSessionId = 0;
/** Live do YouTube usada na transmissão atual (para encerrar lá, se o operador pedir). */
/** Lives do YouTube recebendo esta transmissão (uma por canal). */
let liveBroadcasts: { account: YoutubeAccount; id: string; title: string; channel: string }[] = [];
let extras: LiveExtrasWatcher | null = null;
/** Durante a transmissão o macOS não pode "cochilar" o app (App Nap) com a janela escondida ou minimizada. */
let napBlocker: number | null = null;
const keepAwake = (on: boolean) => {
  if (on && napBlocker === null) napBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && napBlocker !== null) {
    powerSaveBlocker.stop(napBlocker);
    napBlocker = null;
  }
};
const toWindow = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

const dataFile = (name: string) => join(app.getPath('userData'), name);
/** Replays: pedaços da transmissão atual (apagados no fim) e os cortes feitos com ⌘R / Ctrl+R. */
const replay = new ReplayStore(dataFile('replay-buffer'), dataFile('replays'), FFMPEG);
/** Avisa as páginas dos replays abertas quando algo muda (replay novo, enviado ao Drive, renomeado…). */
const galleryEvents = new GalleryEvents();
const sessions = new Sessions(dataFile('transmissoes'), dataFile('replays'), dataFile('transmissao-atual.json'));

/**
 * Menu do macOS sem "Recarregar": o menu padrão do Electron liga ⌘R a recarregar a janela, o que derrubaria
 * a transmissão. ⌘R / Ctrl+R agora é o replay (tratado na tela).
 */
/** Põe a janela no tamanho/posição salvos (dentro de uma tela que existe agora) e no mesmo modo (maximizada/tela cheia). */
function restoreWindow(win: BrowserWindow, w: WindowState): void {
  const area = screen.getDisplayMatching({ x: w.x, y: w.y, width: w.width, height: w.height }).workArea;
  const width = Math.min(w.width, area.width);
  const height = Math.min(w.height, area.height);
  const x = Math.min(Math.max(w.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(w.y, area.y), area.y + area.height - height);
  const apply = () => {
    if (win.isMaximized() && !w.maximized) win.unmaximize();
    win.setBounds({ x, y, width, height });
    if (w.maximized) win.maximize();
    if (w.fullscreen) win.setFullScreen(true);
  };
  if (win.isFullScreen() && !w.fullscreen) {
    // Sair da tela cheia no macOS é animado: o tamanho só pode ser trocado depois.
    win.once('leave-full-screen', () => setTimeout(apply, 50));
    win.setFullScreen(false);
  } else apply();
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'Janela', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools', accelerator: 'Alt+CmdOrCtrl+I' }] },
  ]));
}

// ----- Conta do usuário -----
// Cada conta tem a própria pasta neste Mac (contas/<id>): preferências, layout, projeto, destinos e YouTube.
// Tudo é espelhado na nuvem (Supabase) para entrar em outro computador e encontrar tudo igual.
/** Testes automáticos e cópias de dados (OBS_DATA_DIR) rodam sem login, na pasta deles. */
// Sem servidor de contas configurado o app funciona como antes (sem login), nunca fica preso na entrada.
const LOCAL_ONLY = Boolean(SELF_TEST || E2E || process.env.OBS_DATA_DIR || !CLOUD);
const USER_FILES = ['preferencias.json', 'projeto-atual.json', 'destinos.json', 'youtube.json'];
let accountDir: string | null = LOCAL_ONLY ? app.getPath('userData') : null;
let accountUser: { userId: string; email: string; offline: boolean } | null = LOCAL_ONLY ? { userId: 'local', email: 'local', offline: true } : null;
const userFile = (name: string) => join(accountDir ?? app.getPath('userData'), name);
type SyncState = 'sincronizado' | 'pendente' | 'enviando' | 'sem-internet' | 'erro';
let syncMeta: { dirty: boolean; changedAt: number; syncedAt: string | null } = { dirty: false, changedAt: 0, syncedAt: null };
let syncState: { state: SyncState; message: string | null } = { state: 'sincronizado', message: null };
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncFirstChange = 0;
let syncRunning: Promise<void> | null = null;

const sessionStore = {
  read: async (): Promise<StoredSession | null> => {
    const raw = (await readJson(dataFile('sessao.json'))) as { userId?: string; email?: string; tokenEnc?: string } | null;
    if (!raw?.userId || !raw.tokenEnc) return null;
    try {
      return { userId: raw.userId, email: raw.email ?? '', refreshToken: safeStorage.decryptString(Buffer.from(raw.tokenEnc, 'base64')) };
    } catch {
      return null;
    }
  },
  write: async (session: StoredSession | null): Promise<void> => {
    // A sessão (token de renovação) fica criptografada pelo Keychain; a senha nunca é guardada.
    await writeJson(dataFile('sessao.json'), session ? { userId: session.userId, email: session.email, tokenEnc: safeStorage.encryptString(session.refreshToken).toString('base64') } : null);
  },
};
const cloud = new CloudAccount(CLOUD, sessionStore);

function setSync(state: SyncState, message: string | null = null): void {
  syncState = { state, message };
  toWindow(IPC.accountSync, syncState);
}

/** Algo mudou nas configurações do usuário: sobe para a nuvem alguns segundos depois (agrupando mudanças). */
function markChanged(): void {
  if (LOCAL_ONLY || !accountUser) return;
  const now = Date.now();
  syncMeta = { ...syncMeta, dirty: true, changedAt: now };
  void writeJson(userFile('sincronizacao.json'), syncMeta).catch(() => undefined);
  if (syncState.state !== 'enviando') setSync('pendente');
  if (!syncTimer) syncFirstChange = now;
  if (syncTimer) clearTimeout(syncTimer);
  // 4 s depois da última mudança, mas nunca segura mais de 30 s (arrastar coisas gera mudança contínua).
  const wait = Math.max(0, Math.min(4000, syncFirstChange + 30_000 - now));
  syncTimer = setTimeout(() => { syncTimer = null; void pushNow(); }, wait);
}

async function collect(): Promise<CloudData> {
  return {
    preferences: await readJson(userFile('preferencias.json')),
    project: await readJson(userFile('projeto-atual.json')),
    destinations: (await destinations?.exportPortable()) ?? [],
    youtube: (await youtube?.exportPortable()) ?? null,
  };
}

async function pushNow(): Promise<void> {
  if (LOCAL_ONLY || !accountUser || !cloud.current()) return;
  if (syncRunning) {
    await syncRunning;
    if (!syncMeta.dirty) return;
  }
  syncRunning = (async () => {
    const startedAt = syncMeta.changedAt;
    setSync('enviando');
    try {
      const at = await cloud.push(await collect(), hostname());
      // Se mudou de novo durante o envio, continua pendente (o timer já está marcado).
      syncMeta = { dirty: syncMeta.changedAt !== startedAt, changedAt: syncMeta.changedAt, syncedAt: at };
      await writeJson(userFile('sincronizacao.json'), syncMeta).catch(() => undefined);
      if (accountUser) accountUser.offline = false;
      setSync(syncMeta.dirty ? 'pendente' : 'sincronizado');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSync(/conexão|resposta|internet/i.test(message) ? 'sem-internet' : 'erro', message);
      // Tenta de novo em 1 minuto (nada se perde: está salvo neste Mac).
      if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; void pushNow(); }, 60_000);
    }
  })();
  try {
    await syncRunning;
  } finally {
    syncRunning = null;
  }
}

function makeDrive(file: string): GoogleDrive {
  return new GoogleDrive({
    file,
    vault: {
      encrypt: (t) => safeStorage.encryptString(t).toString('base64'),
      decrypt: (d) => safeStorage.decryptString(Buffer.from(d, 'base64')),
    },
    fetch: (...args) => fetch(...args),
    openBrowser: (url) => (url.startsWith('https://accounts.google.com/') ? shell.openExternal(url) : undefined),
  });
}

/** Nome do projeto aberto: vira a pasta dele no Google Drive (dentro da pasta principal dos replays). */
async function projectName(): Promise<string> {
  const raw = (await readJson(userFile('projeto-atual.json'))) as { name?: unknown } | null;
  return typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : 'Projeto';
}

/** Monta o que vai para o Drive: arquivo, nome (o mesmo da lista, sem data/hora: o Drive já guarda quando foi criado) e pasta do replay. */
async function driveItems(items: { id: string; name?: string | null; folder?: string | null }[]): Promise<{ path: string; name: string; folder: string | null }[]> {
  return items.map((it) => {
    const ext = extname(it.id) || '.mp4';
    return { path: replay.path(it.id), name: `${it.name?.trim() ? it.name.trim().slice(0, 120) : 'Replay'}${ext}`, folder: it.folder?.trim() ? it.folder.trim().slice(0, 100) : null };
  });
}

/** Envio automático: cada corte vai para o Drive em segundo plano, um envio por vez (na ordem dos cortes). */
let autoQueue: Promise<void> = Promise.resolve();
function autoUpload(ids: string[]): void {
  if (!drive || ids.length === 0) return;
  const gd = drive;
  autoQueue = autoQueue.then(async () => {
    const state = await gd.state();
    if (!state.connected || !state.auto) return;
    const [clips, folders] = await Promise.all([replay.list(), replay.folders()]);
    const items = ids.filter((id) => clips.some((c) => c.id === id)).map((id) => {
      const c = clips.find((x) => x.id === id)!;
      return { id, name: clipName(clips, id), folder: folders.find((f) => f.id === c.folder)?.name ?? null };
    });
    const project = await projectName();
    const results = await gd.upload(await driveItems(items), (done, total, name) => toWindow(IPC.driveProgress, { done, total, name }), project);
    const failed = results.filter((r) => !r.ok);
    liveLog(`Google Drive: ${results.length - failed.length} de ${results.length} replay(s) enviados para "${project}"${failed.length ? ` · falhou: ${failed.map((f) => f.error).join('; ')}` : ''}`);
    toWindow(IPC.driveAutoDone, { sent: results.length - failed.length, total: results.length, project, error: failed[0]?.error ?? null });
    galleryEvents.changed();
  }).catch((e) => {
    liveLog(`Google Drive: envio automático falhou (${String(e)})`);
    toWindow(IPC.driveAutoDone, { sent: 0, total: ids.length, project: '', error: e instanceof Error ? e.message : String(e) });
  });
}

function makeYoutube(file: string): YoutubeAccounts {
  return new YoutubeAccounts({
    file,
    vault: {
      encrypt: (t) => safeStorage.encryptString(t).toString('base64'),
      decrypt: (d) => safeStorage.decryptString(Buffer.from(d, 'base64')),
    },
    fetch: (...args) => fetch(...args),
    // Só o endereço de login do Google é aberto no navegador.
    openBrowser: (url) => (url.startsWith('https://accounts.google.com/') ? shell.openExternal(url) : undefined),
    onChange: markChanged,
  });
}

/** Grava neste Mac o que veio da nuvem (sem disparar novo envio). */
async function applyCloud(data: CloudData): Promise<void> {
  try {
    if (data.preferences) await writeJson(userFile('preferencias.json'), validatePreferences(data.preferences));
  } catch { /* preferências inválidas: ficam as locais */ }
  try {
    if (data.project) await writeJson(userFile('projeto-atual.json'), validateProject(data.project));
  } catch { /* projeto inválido: fica o local */ }
  await destinations!.importPortable(data.destinations ?? []);
  await youtube!.importPortable(data.youtube ?? null);
}

/**
 * Abre a conta neste Mac. 1º login de todos: a configuração que já estava no app (de antes de existir login)
 * passa a ser desta conta. Depois, vale a versão mais nova entre a nuvem e este Mac.
 */
async function activateAccount(user: { userId: string; email: string; offline: boolean }): Promise<void> {
  accountDir = join(app.getPath('userData'), 'contas', user.userId.replace(/[^\w-]/g, ''));
  await mkdir(accountDir, { recursive: true });
  accountUser = user;
  destinations = new DestinationStore(userFile('destinos.json'), markChanged);
  youtube = makeYoutube(userFile('youtube.json'));
  drive = makeDrive(userFile('google-drive.json'));
  syncMeta = { dirty: false, changedAt: 0, syncedAt: null, ...((await readJson(userFile('sincronizacao.json'))) as object | null ?? {}) };
  // Conta sem nada neste Mac: adota a configuração de antes de existir login (mesmo sem internet).
  let adopted = false;
  if (!USER_FILES.some((f) => existsSync(userFile(f)))) {
    for (const f of USER_FILES) {
      if (existsSync(dataFile(f))) {
        await rename(dataFile(f), userFile(f));
        adopted = true;
      }
    }
    if (adopted) {
      syncMeta = { ...syncMeta, dirty: true, changedAt: Date.now() };
      await writeJson(userFile('sincronizacao.json'), syncMeta);
    }
  }
  if (user.offline) {
    setSync('sem-internet', 'Sem conexão com a conta: usando o que está salvo neste Mac.');
    return;
  }
  try {
    const row = await cloud.pull();
    if (!row) {
      // Nuvem vazia: a configuração deste Mac sobe.
      syncMeta = { ...syncMeta, dirty: true, changedAt: Date.now() };
      await pushNow();
    } else if (!adopted && syncMeta.dirty && syncMeta.changedAt > Date.parse(row.updatedAt)) {
      // Mudanças feitas aqui sem internet, mais novas que a nuvem: elas sobem.
      await pushNow();
    } else {
      await applyCloud(row.data);
      syncMeta = { dirty: false, changedAt: 0, syncedAt: row.updatedAt };
      await writeJson(userFile('sincronizacao.json'), syncMeta);
      setSync('sincronizado');
    }
  } catch (error) {
    setSync('erro', `Não deu para baixar da conta (${error instanceof Error ? error.message : String(error)}). Usando o que está salvo neste Mac.`);
  }
}

// Fotos e vídeos da transmissão: o endereço próprio precisa ser registrado antes de o app ficar pronto.
registerMediaScheme();
let mediaFiles: MediaFiles | null = null;
void app.whenReady().then(() => {
  mediaFiles = new MediaFiles(dataFile('midias'));
  mediaFiles.handle();
});

/** Entra sozinho com a sessão guardada (como um app comum): a tela de login só aparece na 1ª vez ou após Sair. */
const accountReady: Promise<void> = LOCAL_ONLY
  ? Promise.resolve()
  : app.whenReady().then(async () => {
    const restored = await cloud.restore().catch(() => null);
    if (restored) await activateAccount(restored);
  });

const accountView = () => ({ configured: cloud.configured || LOCAL_ONLY, local: LOCAL_ONLY, user: accountUser ? { email: accountUser.email, offline: accountUser.offline } : null, sync: syncState });

/** Grava em arquivo temporário e renomeia: nunca deixa um JSON pela metade se o app fechar no meio. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function access(kind: 'camera' | 'microphone' | 'screen'): MediaAccess['camera'] {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus(kind) as MediaAccess['camera'];
}

const PRIVACY_PANES = {
  camera: 'Privacy_Camera',
  microphone: 'Privacy_Microphone',
  screen: 'Privacy_ScreenCapture',
} as const;

function registerIpc(): void {
  ipcMain.handle(IPC.mediaAccess, (): MediaAccess => ({ camera: access('camera'), microphone: access('microphone'), screen: access('screen') }));
  ipcMain.handle(IPC.requestAccess, async (_e, kind: unknown) => {
    if (kind !== 'camera' && kind !== 'microphone') return false;
    if (process.platform !== 'darwin') return true;
    return systemPreferences.askForMediaAccess(kind);
  });
  ipcMain.handle(IPC.openPrivacySettings, async (_e, kind: unknown) => {
    if (kind !== 'camera' && kind !== 'microphone' && kind !== 'screen') return;
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[kind]}`);
  });
  ipcMain.handle(IPC.resetMediaPermissions, async () => {
    // Só no app instalado: em desenvolvimento o identificador é o do Electron, que outros apps usam.
    if (!app.isPackaged || process.platform !== 'darwin') return;
    const id = 'br.com.estudioaovivo.app'; // appId do package.json (build.appId)
    const { execFile } = await import('node:child_process');
    const reset = (service: string) => new Promise<void>((resolve) => execFile('/usr/bin/tccutil', ['reset', service, id], () => resolve()));
    await reset('Camera');
    await reset('Microphone');
    liveLog(`permissões: câmera e microfone apagadas para ${id}; reabrindo`);
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle(IPC.listNativeDevices, () => listNativeDevices());
  ipcMain.handle(IPC.probeVideoModes, (_e, label: unknown) => (typeof label === 'string' && label.length < 300 ? probeVideoModes(label) : null));
  ipcMain.handle(IPC.forgetVideoModes, () => forgetVideoModes());

  ipcMain.handle(IPC.loadProject, async () => {
    const raw = await readJson(userFile('projeto-atual.json'));
    try {
      return raw ? validateProject(raw) : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle(IPC.saveProject, async (_e, project: unknown) => {
    await writeJson(userFile('projeto-atual.json'), validateProject(project));
    markChanged();
  });
  ipcMain.handle(IPC.openProjectFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Abrir projeto', filters: [{ name: 'Projeto do Estúdio', extensions: ['estudio', 'json'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return validateProject(JSON.parse(await readFile(result.filePaths[0], 'utf8')));
  });
  ipcMain.handle(IPC.saveProjectFileAs, async (_e, project: unknown) => {
    const valid = validateProject(project);
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Salvar projeto', defaultPath: `${valid.name || 'Projeto'}.estudio`, filters: [{ name: 'Projeto do Estúdio', extensions: ['estudio'] }] });
    if (result.canceled || !result.filePath) return null;
    await writeJson(result.filePath, valid);
    return result.filePath;
  });
  // ----- Layout (Menu › Layout): disposição das áreas + indicadores do Programa + tamanho/posição da janela -----
  ipcMain.handle(IPC.saveLayoutFile, async (_e, data: unknown) => {
    const win = mainWindow;
    if (!win || typeof data !== 'object' || data === null) return null;
    const d = data as { layout?: unknown; hud?: unknown };
    // Maximizada/tela cheia: guarda também o tamanho "normal" para quando sair desse modo.
    const b = win.isFullScreen() || win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    const file: LayoutFile = {
      kind: 'estudio-layout',
      version: 1,
      layout: validLayout(d.layout),
      hud: hudOf(d.hud),
      window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(), fullscreen: win.isFullScreen() },
    };
    const result = await dialog.showSaveDialog(win, { title: 'Salvar layout', defaultPath: 'Meu layout.layout', filters: [{ name: 'Layout do Estúdio', extensions: ['layout'] }] });
    if (result.canceled || !result.filePath) return null;
    await writeJson(result.filePath, file);
    return result.filePath;
  });
  ipcMain.handle(IPC.openLayoutFile, async () => {
    const win = mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { title: 'Importar layout', filters: [{ name: 'Layout do Estúdio', extensions: ['layout', 'json'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(result.filePaths[0], 'utf8'));
    } catch {
      throw new Error('Não foi possível ler o arquivo de layout.');
    }
    const file = layoutFile(raw);
    if (file.window) restoreWindow(win, file.window);
    return { layout: file.layout, hud: file.hud, path: result.filePaths[0] };
  });
  ipcMain.handle(IPC.loadPreferences, async () => validatePreferences(await readJson(userFile('preferencias.json'))));
  ipcMain.handle(IPC.savePreferences, async (_e, prefs: unknown) => {
    await writeJson(userFile('preferencias.json'), validatePreferences(prefs) satisfies Preferences);
    markChanged();
  });

  // ----- Conta -----
  ipcMain.handle(IPC.accountState, async () => {
    await accountReady;
    return accountView();
  });
  ipcMain.handle(IPC.accountLogin, async (_e, email: unknown, password: unknown, create: unknown) => {
    if (LOCAL_ONLY) return accountView();
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 200 || password.length > 200) throw new Error('E-mail ou senha inválidos.');
    const user = create === true ? await cloud.signup(email, password) : await cloud.login(email, password);
    await activateAccount({ ...user, offline: false });
    return accountView();
  });
  ipcMain.handle(IPC.accountLogout, async () => {
    if (LOCAL_ONLY) return accountView();
    if (live) throw new Error('Pare a transmissão antes de sair da conta.');
    // O que ainda não subiu vai antes de sair.
    if (syncMeta.dirty) await pushNow();
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    await cloud.logout();
    closeAllPages();
    accountUser = null;
    accountDir = null;
    destinations = null;
    youtube = null;
    drive = null;
    return accountView();
  });
  ipcMain.handle(IPC.accountSyncNow, async () => {
    if (syncMeta.dirty || syncState.state === 'erro' || syncState.state === 'sem-internet') {
      syncMeta = { ...syncMeta, dirty: true };
      await pushNow();
    }
    return accountView();
  });

  // ----- Celulares (link / QR Code) -----
  /** STUN públicos e, se o operador configurou, o TURN dele (necessário em muitas redes 4G). */
  const iceFor = (prefs: Preferences): IceServer[] => {
    const list: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
    if (prefs.turn) list.push({ urls: prefs.turn.urls.split(','), username: prefs.turn.username, credential: prefs.turn.credential });
    return list;
  };
  const link = async (): Promise<PhoneLink> => {
    const prefs = validatePreferences(await readJson(userFile('preferencias.json')));
    if (phones) phones.ice = iceFor(prefs);
    const token = phones?.token ?? '';
    const base = prefs.publicAddress.replace(/\/+$/, '');
    const remote = tunnel?.state ?? { state: 'desligado' as const, url: null, message: null };
    return {
      urls: phones?.port ? lanAddresses().map((ip) => `https://${ip}:${phones!.port}/c/${token}`) : [],
      publicUrl: remote.url ? `${remote.url}/c/${token}` : base ? `${base}/c/${token}` : null,
      remote,
      port: phones?.port ?? 0,
      running: Boolean(phones?.port),
      error: phones?.error ?? null,
    };
  };
  ipcMain.handle(IPC.phoneLink, () => link());
  ipcMain.handle(IPC.newPhoneLink, async () => {
    await phones?.newToken();
    return link();
  });
  ipcMain.handle(IPC.setPhoneRemote, async (_e, on: unknown) => {
    if (!phones?.port) throw new Error('O servidor dos celulares não está ligado.');
    tunnel ??= new RemoteTunnel(dataFile('cloudflared'), (line) => void appendFile(dataFile('transmissao.log'), `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => undefined), () => void link().then((l) => toWindow(IPC.phoneRemoteChanged, l)));
    if (on === true) void tunnel.start(phones.port);
    else tunnel.stop();
    return link();
  });
  // ----- Transmissões (nova / anteriores) -----
  const notLive = () => {
    if (live && live.status.state !== 'parado') throw new Error('Encerre a transmissão antes de trocar de transmissão.');
  };
  ipcMain.handle(IPC.sessionCurrent, async () => sessions.current(await projectName()));
  ipcMain.handle(IPC.sessionList, () => sessions.list());
  ipcMain.handle(IPC.sessionNew, async (_e, name: unknown, project: unknown) => {
    notLive();
    const valid = validateProject(project);
    const info = await sessions.startNew(typeof name === 'string' ? name : '', valid);
    // A configuração continua; o projeto passa a ter o nome da transmissão nova (pasta dela no Drive).
    await writeJson(userFile('projeto-atual.json'), { ...valid, name: info.name });
    markChanged();
    galleryEvents.changed();
    return info;
  });
  ipcMain.handle(IPC.sessionRestore, async (_e, id: unknown, project: unknown) => {
    notLive();
    if (typeof id !== 'string') throw new Error('Transmissão inválida.');
    const result = await sessions.restore(id, validateProject(project));
    const restored = validateProject(result.project);
    await writeJson(userFile('projeto-atual.json'), restored);
    markChanged();
    galleryEvents.changed();
    return { info: result.info, project: restored };
  });
  ipcMain.handle(IPC.sessionRemove, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Transmissão inválida.');
    return sessions.remove(id);
  });

  // Página dos replays na rede Wi‑Fi (mesmo servidor HTTPS dos celulares, link secreto próprio).
  const galleryLink = () => ({
    urls: phones?.port && phones.replayToken ? lanAddresses().map((ip) => `https://${ip}:${phones!.port}/r/${phones!.replayToken}`) : [],
    running: Boolean(phones?.port),
    error: phones?.error ?? null,
  });
  ipcMain.handle(IPC.replayGalleryLink, () => galleryLink());
  ipcMain.handle(IPC.replayGalleryNewLink, async () => {
    await phones?.newReplayToken();
    return galleryLink();
  });
  ipcMain.handle(IPC.phoneIce, async () => iceFor(validatePreferences(await readJson(userFile('preferencias.json')))));
  ipcMain.handle(IPC.phonesReady, () => phones?.setStudioReady() ?? []);
  ipcMain.handle(IPC.sendToPhone, (_e, id: unknown, message: unknown) => {
    if (typeof id === 'string') phones?.send(id, message);
  });
  ipcMain.handle(IPC.removePhone, (_e, id: unknown) => {
    if (typeof id === 'string') phones?.remove(id);
  });

  // ----- Páginas da web -----
  ipcMain.handle(IPC.openPage, (_e, page: WebPage) => {
    const ok = page && typeof page.id === 'string' && validPageUrl(page.url) && Number.isInteger(page.width) && Number.isInteger(page.height)
      && page.width >= 160 && page.width <= 3840 && page.height >= 120 && page.height <= 2160;
    if (!ok || !mainWindow) throw new Error('Página inválida.');
    return openPage(page, mainWindow.webContents);
  });
  ipcMain.handle(IPC.reloadPage, (_e, id: unknown) => typeof id === 'string' && reloadPage(id));
  ipcMain.handle(IPC.scrollPage, (_e, id: unknown, x: unknown, y: unknown, dx: unknown, dy: unknown) => {
    const n = (v: unknown, lim: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0);
    return typeof id === 'string' ? scrollPage(id, n(x, 4000), n(y, 4000), n(dx, 5000), n(dy, 5000)) : null;
  });
  ipcMain.handle(IPC.closePage, (_e, id: unknown) => typeof id === 'string' && closePage(id));

  // ----- Transmissão: as chaves só existem aqui, criptografadas no Keychain -----
  ipcMain.handle(IPC.listDestinations, () => destinations!.list());
  ipcMain.handle(IPC.saveDestination, (_e, input) => destinations!.save(input));
  ipcMain.handle(IPC.deleteDestination, (_e, id: unknown) => destinations!.remove(String(id)));
  ipcMain.handle(IPC.startLive, async (_e, outputSettings: unknown, mimeType: unknown) => {
    const targets = await destinations!.activeWithKeys();
    if (targets.length === 0) throw new Error('Cadastre e ative pelo menos um destino (YouTube, Facebook…).');
    const format = typeof mimeType === 'string' && mimeType.includes('matroska') ? 'matroska' : 'webm';
    const copyVideo = typeof mimeType === 'string' && /avc1|h264/i.test(mimeType);
    // A partir daqui nenhum pedaço da sessão anterior entra no FFmpeg novo (chegavam sem cabeçalho e
    // derrubavam cada reconexão: "EBML header parsing failed", e o YouTube ficava sem sinal até encerrar a live).
    const sessionId = ++liveSessionId;
    keepAwake(true);
    // Registro da transmissão (sem chaves) para entender qualquer falha: <dados do app>/transmissao.log.
    // Só começa um registro novo numa transmissão nova; reconexões e trocas de formato continuam o mesmo.
    const logFile = dataFile('transmissao.log');
    const fresh = !live || live.status.state === 'parado';
    if (fresh) {
      // O registro da transmissão anterior fica guardado (para entender uma queda depois).
      await rename(logFile, dataFile('transmissao-anterior.log')).catch(() => undefined);
      await writeFile(logFile, '', 'utf8');
    }
    const log = (line: string) => void appendFile(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => undefined);
    liveLog = log;
    // Lives dos canais do YouTube: confere antes se cada uma ainda recebe vídeo. Uma live que terminou (o YouTube
    // encerra sozinho quando o envio para) aceita o vídeo na chave, mas ninguém consegue assistir.
    const ytTargets: typeof liveBroadcasts = [];
    for (const t of targets.filter((x) => isYoutubeDestination(x.id))) {
      const accountId = accountOfDestination(t.id);
      const account = accountId ? await youtube!.get(accountId).catch(() => null) : null;
      if (!account) {
        log(`YouTube: o destino "${t.name}" não tem mais canal conectado`);
        continue;
      }
      const channel = (await account.state()).channel?.title ?? 'canal';
      const target = await account.target().catch((e) => { log(`YouTube (${channel}): não deu para conferir a live (${String(e)})`); return undefined; });
      if (!target) continue;
      log(`YouTube (${channel}): live "${target.title}" (${target.id}) está ${target.status ?? 'apagada'}`);
      if (target.status === null || ENDED.has(target.status)) {
        const msg = `${channel}: ${endedMessage(target.title, target.status)}`;
        log(`bloqueado: ${msg}`);
        throw new Error(msg);
      }
      // Live antiga (criada com "parada automática"): desliga, para uma queda curta não encerrá-la.
      await account.keepOpen(target.id).then((ok) => ok && log(`YouTube (${channel}): parada automática desligada (a live só termina quando o operador encerrar)`))
        .catch((e) => log(`YouTube (${channel}): não deu para desligar a parada automática (${String(e)})`));
      ytTargets.push({ account, id: target.id, title: target.title, channel });
    }
    liveBroadcasts = ytTargets;
    if (sessionId !== liveSessionId) throw new Error('Transmissão substituída por outra.');
    // Ao reabrir (troca de formato, reconexão), a sessão antiga sai sem anunciar "parado".
    live?.silence();
    // RTMPS passa pelo túnel TLS do app (a criptografia do FFmpeg embutido derruba o YouTube).
    tunnels.forEach((t) => t.close());
    tunnels = [];
    const routed = await Promise.all(targets.map(async (t) => {
      if (!t.url.toLowerCase().startsWith('rtmps://')) return t;
      const tunnel = await openTlsTunnel(t.url, log);
      tunnels.push(tunnel);
      return { ...t, url: tunnel.url };
    }));
    live = new LiveSession(routed, (status) => toWindow(IPC.liveStatus, status), log);
    // Replay só dos dispositivos (câmeras e celulares da cena, gravados pela tela): o Programa não é gravado
    // para replay (o operador quer o lance visto pelas câmeras, e é um trabalho a menos para o Mac na live).
    replay.setLog(log);
    live.start(validOutput(outputSettings), format, copyVideo, null);
    toWindow(IPC.liveStatus, live.status);
    if (youtubeWatch) clearInterval(youtubeWatch);
    youtubeWatch = null;
    if (ytTargets.length > 0) {
      const last = new Map<string, string | null>();
      const ended = new Set<string>();
      const session = live;
      const onlyYoutube = targets.length === ytTargets.length;
      youtubeWatch = setInterval(async () => {
        if (live !== session || session.status.state !== 'ao-vivo') return;
        for (const yt of ytTargets) {
          if (ended.has(yt.id)) continue;
          const status = await yt.account.lifeCycle(yt.id).catch(() => undefined);
          if (status === undefined) continue;
          if (status !== last.get(yt.id)) log(`YouTube (${yt.channel}): live "${yt.title}" agora está ${status ?? 'apagada'}`);
          last.set(yt.id, status);
          if (status === null || ENDED.has(status)) {
            ended.add(yt.id);
            const msg = `${yt.channel}: ${liveMessage(yt.title, status) ?? endedMessage(yt.title, status)}`;
            // Terminou em todos os lugares: para de verdade. A tela nunca pode dizer "ao vivo" com a live encerrada.
            if (onlyYoutube && ended.size === ytTargets.length) {
              if (youtubeWatch) clearInterval(youtubeWatch);
              youtubeWatch = null;
              session.end(msg);
              return;
            }
            session.note(msg);
            continue;
          }
          const msg = liveMessage(yt.title, status);
          if (msg) session.note(ytTargets.length > 1 ? `${yt.channel}: ${msg}` : msg);
        }
      }, 10000);
    }
    return sessionId;
  });
  ipcMain.on(IPC.liveLogLine, (_e, line: unknown) => {
    if (typeof line === 'string') liveLog(`tela: ${line.slice(0, 300)}`);
  });
  ipcMain.on(IPC.liveChunk, (_e, session: unknown, chunk: unknown) => {
    if (session !== liveSessionId) return;
    if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) live?.write(Buffer.from(chunk as ArrayBuffer));
  });
  ipcMain.handle(IPC.replayCut, async (_e, seconds: unknown) => {
    const s = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(Math.min(30, Math.max(7, seconds))) : 15;
    const clips = await replay.cut(s);
    galleryEvents.changed();
    autoUpload(clips.map((c) => c.id));
    return clips;
  });
  ipcMain.handle(IPC.replayList, () => replay.list());
  ipcMain.handle(IPC.replayRead, async (_e, id: unknown) => {
    if (!validClipId(id)) throw new Error('Replay inválido.');
    return new Uint8Array(await readFile(replay.path(id)));
  });
  ipcMain.handle(IPC.replayDelete, (_e, id: unknown) => {
    if (!validClipId(id)) throw new Error('Replay inválido.');
    return replay.remove(id).finally(() => galleryEvents.changed());
  });
  // Copiar links: navigator.clipboard do Chromium recusa sem foco/permissão na janela do app (botões "Copiar" não faziam nada)
  ipcMain.handle(IPC.copyText, (_e, text: unknown) => {
    if (typeof text === 'string' && text.length <= 4000) clipboard.writeText(text);
  });
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) && url.length <= 2000) void shell.openExternal(url);
  });
  ipcMain.handle(IPC.replayReveal, (_e, id: unknown) => {
    if (validClipId(id)) shell.showItemInFolder(replay.path(id));
  });
  ipcMain.handle(IPC.replayUpdate, (_e, id: unknown, patch: unknown) => {
    if (!validClipId(id)) throw new Error('Replay inválido.');
    return replay.update(id, patch).finally(() => galleryEvents.changed());
  });
  ipcMain.handle(IPC.replayFolders, () => replay.folders());
  // Gravação de cada câmera para o replay (a tela liga/desliga conforme a transmissão e as câmeras conectadas).
  ipcMain.handle(IPC.replayCamStart, (_e, key: unknown, label: unknown, mimeType: unknown) => {
    if (!validCamKey(key)) throw new Error('Câmera inválida.');
    const mime = typeof mimeType === 'string' ? mimeType : '';
    return replay.camStart(key, typeof label === 'string' ? label.slice(0, 120) : 'Câmera', mime.includes('matroska') ? 'matroska' : 'webm', /avc1|h264/i.test(mime));
  });
  ipcMain.on(IPC.replayCamChunk, (_e, key: unknown, chunk: unknown) => {
    if (validCamKey(key) && (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk))) replay.camWrite(key, Buffer.from(chunk as ArrayBuffer));
  });
  ipcMain.handle(IPC.replayCamStop, (_e, key: unknown) => (validCamKey(key) ? replay.camStop(key) : undefined));
  ipcMain.handle(IPC.replaySaveFolders, (_e, folders: unknown) => replay.saveFolders(folders).finally(() => galleryEvents.changed()));
  // Vídeo de abertura dos replays: copiado para a pasta do app (o original pode sair do lugar).
  // Entrada mantém o nome antigo do arquivo (quem já tinha abertura não perde).
  const introFile = (which: 'entrada' | 'saida', ext: string) => dataFile(`replay-${which === 'saida' ? 'saida' : 'abertura'}.${ext}`);
  const vignette = (which: unknown): 'entrada' | 'saida' => {
    if (which !== 'entrada' && which !== 'saida') throw new Error('Vinheta inválida.');
    return which;
  };
  const INTRO_EXT = ['mp4', 'mov', 'm4v', 'webm'];
  ipcMain.handle(IPC.replayIntroPick, async (_e, which: unknown) => {
    const kind = vignette(which);
    const result = await dialog.showOpenDialog(mainWindow!, { title: kind === 'saida' ? 'Vinheta de saída do replay' : 'Vinheta de entrada do replay', filters: [{ name: 'Vídeo', extensions: INTRO_EXT }], properties: ['openFile'] });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const ext = extname(file).slice(1).toLowerCase();
    if (!INTRO_EXT.includes(ext)) throw new Error('Use um vídeo MP4, MOV, M4V ou WebM.');
    if ((await stat(file)).size > 500 * 1024 * 1024) throw new Error('A vinheta pode ter no máximo 500 MB.');
    for (const old of INTRO_EXT) await rm(introFile(kind, old), { force: true }).catch(() => undefined);
    await copyFile(file, introFile(kind, ext));
    return { name: basename(file).slice(0, 200), ext };
  });
  ipcMain.handle(IPC.replayIntroRead, async (_e, which: unknown, ext: unknown) => {
    const kind = vignette(which);
    if (typeof ext !== 'string' || !INTRO_EXT.includes(ext)) throw new Error('Vinheta inválida.');
    return new Uint8Array(await readFile(introFile(kind, ext)));
  });
  ipcMain.handle(IPC.mediaPick, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Foto ou vídeo para a transmissão',
      filters: [{ name: 'Foto ou vídeo', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] }, { name: 'Foto', extensions: [...IMAGE_EXTENSIONS] }, { name: 'Vídeo', extensions: [...VIDEO_EXTENSIONS] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !mediaFiles) return [];
    const imported = [];
    for (const file of result.filePaths.slice(0, 30)) imported.push(await mediaFiles.import(file));
    return imported;
  });
  ipcMain.handle(IPC.mediaRemove, (_e, id: unknown, ext: unknown) => (typeof id === 'string' && typeof ext === 'string' ? mediaFiles?.remove(id, ext) : undefined));
  ipcMain.handle(IPC.replayIntroClear, async (_e, which: unknown) => {
    const kind = vignette(which);
    for (const ext of INTRO_EXT) await rm(introFile(kind, ext), { force: true }).catch(() => undefined);
  });
  ipcMain.handle(IPC.readLiveLog, async () => readFile(dataFile('transmissao.log'), 'utf8').catch(() => ''));

  // ----- Canais do YouTube (API oficial; tokens e chaves só aqui, no Keychain) -----
  const yt = (id: unknown) => {
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('Canal inválido.');
    return youtube!.get(id);
  };
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  ipcMain.handle(IPC.youtubeAccounts, () => youtube!.list());
  ipcMain.handle(IPC.youtubeAdd, () => youtube!.add());
  ipcMain.handle(IPC.youtubeRemove, async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Canal inválido.');
    const accounts = await youtube!.remove(id);
    return { accounts, destinations: await destinations!.remove(youtubeDestinationId(id)) };
  });
  ipcMain.handle(IPC.youtubeState, async (_e, id: unknown) => (await yt(id)).state());
  ipcMain.handle(IPC.youtubeSetClient, async (_e, id: unknown, clientId: unknown, secret: unknown) => (await yt(id)).setClient(text(clientId), text(secret)));
  ipcMain.handle(IPC.youtubeConnect, async (_e, id: unknown) => {
    const state = await (await yt(id)).connect();
    mainWindow?.focus();
    return state;
  });
  ipcMain.handle(IPC.youtubeCancel, async () => {
    for (const s of await youtube!.list()) (await youtube!.get(s.id)).cancel();
  });
  ipcMain.handle(IPC.youtubeDisconnect, async (_e, id: unknown) => (await yt(id)).disconnect());
  ipcMain.handle(IPC.youtubeBroadcasts, async (_e, id: unknown) => (await yt(id)).broadcasts());
  ipcMain.handle(IPC.youtubeCreate, async (_e, id: unknown, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const privacy = i.privacy === 'public' || i.privacy === 'unlisted' || i.privacy === 'private' ? i.privacy : 'unlisted';
    return (await yt(id)).create({ title: text(i.title), description: text(i.description), scheduledStart: text(i.scheduledStart), privacy });
  });
  ipcMain.handle(IPC.youtubeUse, async (_e, accountId: unknown, id: unknown) => {
    if (typeof id !== 'string' || !/^[\w-]{5,64}$/.test(id)) throw new Error('Transmissão inválida.');
    const account = await yt(accountId);
    const { server, key, title } = await account.prepare(id);
    const channel = (await account.state()).channel?.title;
    return destinations!.upsertManaged(youtubeDestinationId(accountId as string), 'youtube', `YouTube${channel ? ` (${channel})` : ''} · ${title}`, server, key);
  });

  // ----- Google Drive (replays marcados vão para uma pasta do Estúdio no Drive) -----
  const gd = () => {
    if (!drive) throw new Error('Entre na conta do Estúdio primeiro.');
    return drive;
  };
  ipcMain.handle(IPC.driveState, () => gd().state());
  ipcMain.handle(IPC.driveSetClient, (_e, id: unknown, secret: unknown) => gd().setClient(text(id), text(secret)));
  ipcMain.handle(IPC.driveUseYoutubeClient, async () => {
    const first = (await youtube!.exportPortable())[0];
    if (!first) throw new Error('Nenhum canal do YouTube com chave cadastrada.');
    return gd().setClient(first.clientId, first.clientSecret);
  });
  ipcMain.handle(IPC.driveConnect, async () => {
    const state = await gd().connect();
    mainWindow?.focus();
    return state;
  });
  ipcMain.handle(IPC.driveCancel, () => gd().cancel());
  ipcMain.handle(IPC.driveDisconnect, () => gd().disconnect());
  ipcMain.handle(IPC.driveSetFolder, (_e, name: unknown) => gd().setFolder(text(name)));
  ipcMain.handle(IPC.driveUpload, async (_e, items: unknown) => {
    const list = (Array.isArray(items) ? items : []).slice(0, 200).flatMap((i) => {
      const it = i as { id?: unknown; name?: unknown; folder?: unknown };
      return validClipId(it?.id) ? [{ id: it.id as string, name: typeof it.name === 'string' ? it.name : null, folder: typeof it.folder === 'string' ? it.folder : null }] : [];
    });
    if (list.length === 0) throw new Error('Nenhum replay para enviar.');
    return gd().upload(await driveItems(list), (done, total, name) => toWindow(IPC.driveProgress, { done, total, name }), await projectName()).finally(() => galleryEvents.changed());
  });
  ipcMain.handle(IPC.driveOpenFolder, async () => {
    const { url } = await gd().projectFolder(await projectName());
    if (url.startsWith('https://drive.google.com/')) await shell.openExternal(url);
  });
  ipcMain.handle(IPC.driveSetAuto, (_e, on: unknown) => gd().setAuto(on === true));
  ipcMain.handle(IPC.driveProjectFolder, async (_e, share: unknown) => ({ ...(await gd().projectFolder(await projectName(), share === true)), project: await projectName() }));

  // ----- Arquivo de chaves (canais do YouTube + destinos), protegido por senha -----
  ipcMain.handle(IPC.keysExport, async (_e, password: unknown) => {
    const data = { kind: 'estudio-chaves-dados', youtube: await youtube!.exportPortable(), destinations: await destinations!.exportPortable() };
    if (data.youtube.length === 0 && data.destinations.length === 0) throw new Error('Não há canais nem destinos para baixar.');
    const sealed = sealKeys(data, typeof password === 'string' ? password : '');
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Baixar chaves de acesso', defaultPath: 'Chaves do Estúdio.chaves', filters: [{ name: 'Chaves do Estúdio', extensions: ['chaves'] }] });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, sealed, { encoding: 'utf8', mode: 0o600 });
    return { path: result.filePath, channels: data.youtube.length, destinations: data.destinations.length };
  });
  let keysPicked: string | null = null;
  ipcMain.handle(IPC.keysPick, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Importar chaves de acesso', filters: [{ name: 'Chaves do Estúdio', extensions: ['chaves'] }], properties: ['openFile'] });
    keysPicked = result.canceled ? null : result.filePaths[0] ?? null;
    return keysPicked ? basename(keysPicked) : null;
  });
  ipcMain.handle(IPC.keysImport, async (_e, password: unknown): Promise<KeysImportResult> => {
    if (!keysPicked) throw new Error('Escolha o arquivo de chaves.');
    if ((await stat(keysPicked)).size > 2 * 1024 * 1024) throw new Error('Este arquivo não é um arquivo de chaves do Estúdio ao Vivo.');
    const data = openKeys(await readFile(keysPicked, 'utf8'), typeof password === 'string' ? password : '') as { youtube?: unknown; destinations?: unknown };
    const channels = Array.isArray(data?.youtube) ? data.youtube : [];
    const ids = await youtube!.merge(channels);
    const rename = (destId: string) => {
      const acc = accountOfDestination(destId);
      return acc && ids.has(acc) ? youtubeDestinationId(ids.get(acc)!) : destId;
    };
    const count = await destinations!.mergePortable(Array.isArray(data?.destinations) ? data.destinations : [], rename);
    keysPicked = null;
    return { channels: ids.size, destinations: count };
  });

  ipcMain.handle(IPC.stopLive, async (_e, endBroadcast: unknown) => {
    keepAwake(false);
    if (youtubeWatch) clearInterval(youtubeWatch);
    youtubeWatch = null;
    liveSessionId++;
    live?.stop();
    live = null;
    // Espera o FFmpeg fechar antes de apagar os pedaços do replay.
    setTimeout(() => { if (!live) void replay.end(); }, 6000);
    void replay.camStopAll();
    const broadcasts = liveBroadcasts;
    liveBroadcasts = [];
    for (const broadcast of broadcasts) {
      liveLog(endBroadcast === true ? `operador encerrou a live "${broadcast.title}" no YouTube (${broadcast.channel})` : `envio parado; a live "${broadcast.title}" (${broadcast.channel}) continua aberta no YouTube para voltar a transmitir`);
      // Espera o FFmpeg fechar a conexão antes de encerrar a live (senão os últimos segundos se perdem).
      if (endBroadcast === true) setTimeout(() => void broadcast.account.complete(broadcast.id).catch((e) => liveLog(`YouTube (${broadcast.channel}): não deu para encerrar a live (${String(e)})`)), 4000);
    }
    // Dá tempo do FFmpeg fechar a conexão com a plataforma antes de derrubar o túnel.
    const closing = tunnels;
    tunnels = [];
    setTimeout(() => closing.forEach((t) => t.close()), 6000);
  });

  ipcMain.handle(IPC.watchLiveExtras, (_e, opts: unknown) => {
    const o = (opts ?? {}) as { stats?: unknown; chat?: unknown };
    let lastHealth = '';
    // Números e comentários: do primeiro canal do YouTube ligado nos destinos (ou do primeiro conectado).
    const primary = async (): Promise<YoutubeAccount | null> => {
      const enabled = (await destinations!.list()).find((d) => d.enabled && isYoutubeDestination(d.id));
      const id = enabled ? accountOfDestination(enabled.id) : (await youtube!.list()).find((a) => a.connected)?.id;
      return id ? youtube!.get(id).catch(() => null) : null;
    };
    extras ??= new LiveExtrasWatcher({
      state: async () => (await primary())?.state() ?? { id: '', configured: false, connected: false, channel: null, clientId: '' },
      target: async () => (await primary())?.target() ?? null,
      liveDetails: async (id) => (await primary())!.liveDetails(id),
      chatMessages: async (chatId, token) => (await primary())!.chatMessages(chatId, token),
    }, (state) => {
      toWindow(IPC.liveExtras, state);
      // O que o YouTube diz do sinal vai para o registro (para entender um "sinal ruim" depois).
      const health = `${state.health ?? '-'}${state.issues.length ? ` (${state.issues.join('; ')})` : ''}`;
      if (state.available && health !== lastHealth) liveLog(`YouTube: sinal ${health}${state.viewers != null ? ` · ${state.viewers} assistindo` : ''}`);
      lastHealth = health;
    });
    extras.watch({ stats: o.stats === true, chat: o.chat === true });
  });

  ipcMain.handle(IPC.isSelfTest, () => (SELF_TEST ? (['gravador', 'chroma', 'pagina'].includes(process.env.OBS_E2E ?? '') ? process.env.OBS_E2E : E2E ? 'e2e' : 'dispositivos') : null));
  // Só no teste: abre um "celular" (janela com câmera falsa) no link, como uma pessoa faria.
  ipcMain.handle('e2e:phone', async (_e, url: unknown) => {
    if (!E2E || typeof url !== 'string') return;
    const phone = new BrowserWindow({ show: false, width: 420, height: 860, webPreferences: { partition: 'e2e-celular', sandbox: true, contextIsolation: true } });
    phone.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
    await phone.loadURL(url);
    await phone.webContents.executeJavaScript("document.getElementById('name').value = 'Celular de teste'; document.getElementById('start').click(); true", true);
    e2ePhone = phone;
  });
  ipcMain.handle('e2e:phone-status', async () => (e2ePhone && !e2ePhone.isDestroyed() ? e2ePhone.webContents.executeJavaScript("document.getElementById('status-text').textContent") : null));
  ipcMain.handle(IPC.reportSelfTest, async (_e, report: unknown) => {
    if (!SELF_TEST) return;
    await writeFile(SELF_TEST, JSON.stringify(report, null, 2), 'utf8');
    app.quit();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1200,
    minHeight: 760,
    // OBS_TEST_SHOW=1: o teste roda com a janela visível (como o operador usa), sem roubar o foco.
    show: SELF_TEST === null,
    backgroundColor: '#0b0c0e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // A captura continua a todo vapor mesmo com a janela atrás de outra.
      backgroundThrottling: false,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (SELF_TEST && process.env.OBS_TEST_SHOW === '1') mainWindow.showInactive();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!DEV_URL || !url.startsWith(DEV_URL)) event.preventDefault();
  });
  if (DEV_URL) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  // Teste: esconde a janela depois de um tempo (como quando o operador vai ao navegador conferir a live).
  const hideAfter = Number(process.env.OBS_TEST_MINIMIZE_AFTER ?? 0);
  if (hideAfter > 0) {
    const window = mainWindow;
    setTimeout(() => window.minimize(), hideAfter);
  }

  // Conferência visual (OBS_SCREENSHOT=arquivo.png): fotografa a janela depois que tudo abriu e fecha.
  const shot = process.env.OBS_SCREENSHOT;
  if (shot) {
    const window = mainWindow;
    window.webContents.once('did-finish-load', () => setTimeout(async () => {
      // Roteiro opcional de cliques (ex.: abrir a prévia e as configurações) antes da foto.
      const script = process.env.OBS_SCREENSHOT_SCRIPT;
      window.webContents.on('console-message', (event) => console.log('[tela]', (event as unknown as { message: string }).message));
      if (script) {
        const result = await window.webContents.executeJavaScript(script, true).catch((e) => `erro no roteiro: ${e}`);
        console.log('[roteiro]', JSON.stringify(result));
        await new Promise((r) => setTimeout(r, 3500));
      }
      const image = await window.webContents.capturePage();
      await writeFile(shot, image.toPNG());
      app.quit();
    }, Number(process.env.OBS_SCREENSHOT_DELAY ?? 9000)));
  }
}

/**
 * Versão nova do app instalado (assinatura local muda a cada versão): o macOS mantém a permissão de câmera e
 * microfone da versão anterior como "permitida", mas ela não vale para a nova, e a lista de aparelhos fica sem
 * resposta. Na 1ª abertura de cada versão, apaga a decisão antiga deste app; o macOS pergunta de novo
 * (askForMediaAccess logo depois) e a pessoa só clica em "Permitir".
 */
async function resetMediaOnNewBuild(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    // Arquivo da assinatura: reescrito a cada build assinado (= identidade nova para o macOS). NÃO usar o
    // app.asar: o Electron o trata como pasta virtual e devolve tamanho 0 e horário de agora, e a permissão
    // seria apagada em toda abertura.
    const signature = join(process.resourcesPath, '..', '_CodeSignature', 'CodeResources');
    const info = await stat(signature);
    const stamp = `${app.getVersion()}|${info.size}|${Math.round(info.mtimeMs)}`;
    const file = join(app.getPath('userData'), 'versao-permissoes.txt');
    const previous = await readFile(file, 'utf8').catch(() => '');
    if (previous.trim() === stamp) return;
    const { execFile } = await import('node:child_process');
    const reset = (service: string) => new Promise<void>((resolve) => execFile('/usr/bin/tccutil', ['reset', service, 'br.com.estudioaovivo.app'], () => resolve()));
    await reset('Camera');
    await reset('Microphone');
    await writeFile(file, stamp, 'utf8');
    liveLog(`permissões: versão nova (${stamp}); permissão antiga de câmera e microfone apagada, o macOS pergunta de novo`);
  } catch (e) {
    liveLog(`permissões: não foi possível conferir a versão (${String(e)})`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    // Só câmera e microfone; o macOS ainda pede a autorização dele na primeira vez.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const media = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'video' || t === 'audio');
      callback(Boolean(media) || permission === 'speaker-selection');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'speaker-selection');
    if (E2E) {
      // O celular simulado aceita o certificado local, como a pessoa faz tocando em "Continuar".
      app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
        if (url.startsWith('https://') && phones?.port && new URL(url).port === String(phones.port)) {
          event.preventDefault();
          callback(true);
        }
      });
    }
    if (process.platform === 'darwin') {
      await resetMediaOnNewBuild();
      // Com prazo: se o pedido do macOS não aparecer ou ficar sem resposta, a janela abre mesmo assim (antes o
      // app ficava rodando sem janela). O pedido continua valendo e pode ser respondido depois.
      const ask = (kind: 'camera' | 'microphone') => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          systemPreferences.askForMediaAccess(kind).catch(() => false),
          new Promise<boolean>((r) => { timer = setTimeout(() => { liveLog(`abertura: permissão de ${kind} sem resposta em 20 s, abrindo a janela`); r(false); }, 20_000); }),
        ]).finally(() => clearTimeout(timer));
      };
      await ask('camera');
      await ask('microphone');
    }
    if (LOCAL_ONLY) {
      destinations = new DestinationStore(userFile('destinos.json'));
      youtube = makeYoutube(userFile('youtube.json'));
      drive = makeDrive(userFile('google-drive.json'));
    }
    phones = new PhoneServer(dataFile('celular.json'), (event) => toWindow(IPC.phoneEvent, event));
    phones.gallery = (rest, url, req, res) => handleGallery({
      list: () => replay.list(),
      folders: () => replay.folders(),
      path: (id) => replay.path(id),
      project: projectName,
      events: galleryEvents,
      drive: {
        list: async () => (drive ? drive.listProject(await projectName()) : null),
        stream: (fileId, range) => (drive ? drive.stream(fileId, range) : Promise.reject(new Error('Google Drive não conectado.'))),
      },
    }, rest, url, req, res);
    await phones.start(Number(process.env.OBS_PHONE_PORT ?? 8443));
    // STUN/TURN salvos já valem para o primeiro celular, mesmo antes de abrir a janela do link.
    void readJson(userFile('preferencias.json')).then((raw) => {
      const turn = validatePreferences(raw).turn;
      if (phones && turn) phones.ice = [...phones.ice, { urls: turn.urls.split(','), username: turn.username, credential: turn.credential }];
    }, () => undefined);
    // Diagnóstico (só com OBS_DIAG_YOUTUBE e autorização do operador): manda 20 s de barras coloridas pelo
    // caminho completo da transmissão até o destino do YouTube e fecha. Nunca usa câmera nem microfone.
    const diag = process.env.OBS_DIAG_YOUTUBE;
    if (diag) {
      const targets = (await destinations?.activeWithKeys()) ?? [];
      const yt = targets.find((t) => isYoutubeDestination(t.id)) ?? targets[0];
      const results = [];
      if (yt) {
        // Caminho completo da transmissão (mesmos parâmetros, tee e túnel), alimentado com barras coloridas.
        const lines: string[] = [];
        const tunnel = await openTlsTunnel(yt.url, (l) => lines.push(l));
        const statuses: string[] = [];
        const session = new LiveSession([{ ...yt, url: tunnel.url }], (st) => statuses.push(`${st.state} ${st.fps}fps ${st.message ?? ''}`), (l) => lines.push(l));
        session.start({ width: 1920, height: 1080, fps: 30, bitrate: 6000, encoder: 'hardware' }, 'matroska');
        const { spawn } = await import('node:child_process');
        const ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;
        const source = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-f', 'matroska', 'pipe:1']);
        source.stdout.on('data', (c: Buffer) => session.write(c));
        await new Promise((r) => source.on('close', r));
        session.stop();
        await new Promise((r) => setTimeout(r, 4000));
        tunnel.close();
        results.push({ estados: [...new Set(statuses.map((x) => x.split(' ')[0]))], ultimo: statuses.at(-2) ?? null, registro: lines.filter((l) => !/ffmpeg: \[(matroska|flv)/.test(l)).slice(0, 20) });
      }
      await writeFile(diag, JSON.stringify({ destino: yt?.name ?? null, results }, null, 2), 'utf8');
      app.quit();
      return;
    }
    registerIpc();
    installMenu();
    void replay.end();
    void replay.camStopAll();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  let flushed = false;
  app.on('before-quit', (event) => {
    // Mudanças que ainda não subiram para a conta: espera o envio (até 5 s) antes de fechar.
    if (!flushed && syncMeta.dirty && cloud.current() && !LOCAL_ONLY) {
      event.preventDefault();
      flushed = true;
      void Promise.race([pushNow(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.quit());
      return;
    }
    extras?.watch({ stats: false, chat: false });
    live?.stop();
    tunnel?.stop();
    phones?.stop();
    closeAllPages();
  });
}
