import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { DriveListing, DriveState, DriveUploadResult, DriveVideo } from '../../src/types/studio';
import type { Vault } from './youtube';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
/** Só os arquivos e pastas que o próprio Estúdio criar no Drive (não vê o resto do Drive). */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DEFAULT_FOLDER = 'Estúdio ao Vivo · Replays';
/** Replays maiores que isso não são enviados (lidos inteiros na memória). */
const MAX_BYTES = 1024 * 1024 * 1024;

interface Stored {
  clientId: string;
  clientSecretEnc: string;
  refreshTokenEnc: string | null;
  email: string | null;
  folderName: string;
  /** Pasta criada pelo Estúdio no Drive (refeita se for apagada). */
  folderId: string | null;
  /** Cada replay cortado vai sozinho para o Drive (ausente = sim). */
  auto?: boolean;
}

export interface DriveDeps {
  file: string;
  vault: Vault;
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<void> | void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function explain(status: number, body: unknown): string {
  const err = (body as { error?: { message?: string; errors?: { reason?: string }[] } | string; error_description?: string })?.error;
  const reason = typeof err === 'object' ? err?.errors?.[0]?.reason : undefined;
  const text = typeof err === 'object' ? err?.message : (body as { error_description?: string })?.error_description ?? err;
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(String(text))) return 'A Google Drive API não está ativada no projeto do Google Cloud. Ative em console.cloud.google.com → APIs e serviços → Biblioteca → Google Drive API.';
  if (reason === 'storageQuotaExceeded') return 'O Google Drive está cheio.';
  if (text === 'invalid_grant') return 'O acesso ao Google Drive expirou ou foi revogado. Conecte a conta de novo em Configurações › Google Drive.';
  if (text === 'invalid_client') return 'ID ou chave secreta do cliente OAuth inválidos. Confira no Google Cloud.';
  return `Google Drive: ${text ?? `erro ${status}`}`;
}

/** Nome de arquivo aceitável (sem barras nem caracteres de controle). */
const cleanName = (name: string) => name.replace(/[\u0000-\u001f/\\]+/g, ' ').trim().slice(0, 180) || 'Replay';

/**
 * Conta do Google Drive para guardar os replays. Login no navegador (OAuth com PKCE, retorno em 127.0.0.1),
 * com o cliente OAuth do próprio operador; tokens só no Keychain.
 */
export class GoogleDrive {
  private stored: Stored | null = null;
  private access: { token: string; expires: number } | null = null;
  private pending: (() => void) | null = null;

  constructor(private deps: DriveDeps) {}

  private async load(): Promise<Stored | null> {
    if (this.stored) return this.stored;
    try {
      this.stored = JSON.parse(await readFile(this.deps.file, 'utf8')) as Stored;
    } catch {
      this.stored = null;
    }
    return this.stored;
  }

  private async save(stored: Stored | null): Promise<void> {
    this.stored = stored;
    const temp = `${this.deps.file}.tmp`;
    await writeFile(temp, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.deps.file);
  }

  async state(): Promise<DriveState> {
    const s = await this.load();
    return { configured: Boolean(s?.clientId), connected: Boolean(s?.refreshTokenEnc), email: s?.email ?? null, clientId: s?.clientId ?? '', folderName: s?.folderName ?? DEFAULT_FOLDER, auto: s?.auto !== false };
  }

  async setClient(clientId: string, clientSecret: string): Promise<DriveState> {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('ID do cliente inválido: deve terminar em .apps.googleusercontent.com.');
    if (!/^[\w-]{10,100}$/.test(secret)) throw new Error('Chave secreta do cliente inválida.');
    const s = await this.load();
    await this.save({ clientId: id, clientSecretEnc: this.deps.vault.encrypt(secret), refreshTokenEnc: null, email: null, folderName: s?.folderName ?? DEFAULT_FOLDER, folderId: null });
    this.access = null;
    return this.state();
  }

  async setAuto(auto: boolean): Promise<DriveState> {
    const s = await this.load();
    if (!s) throw new Error('Cadastre primeiro a chave do Google Drive.');
    await this.save({ ...s, auto });
    return this.state();
  }

  /**
   * Pasta do projeto no Drive (dentro da pasta principal) e o link para abri-la. share = qualquer pessoa com
   * o link pode ver (só a pasta do projeto e o que estiver nela).
   */
  async projectFolder(project: string, share = false): Promise<{ url: string; shared: boolean }> {
    const root = await this.folder();
    const id = await this.subfolder(root, project);
    if (share) await this.api('POST', `${API}/files/${encodeURIComponent(id)}/permissions?fields=id`, { type: 'anyone', role: 'reader' });
    const info = await this.api<{ webViewLink?: string; permissions?: { type?: string }[] }>('GET', `${API}/files/${encodeURIComponent(id)}?fields=webViewLink,permissions(type)`).catch(() => ({ webViewLink: undefined, permissions: undefined }));
    return { url: info.webViewLink ?? `https://drive.google.com/drive/folders/${id}`, shared: Boolean(info.permissions?.some((p) => p.type === 'anyone')) };
  }

  /**
   * Conteúdo da pasta do projeto no Drive (para a página dos replays): os vídeos soltos nela e os de cada
   * subpasta (pastas da área Replay). null = Drive não conectado.
   */
  async listProject(project: string): Promise<DriveListing | null> {
    const s = await this.load();
    if (!s?.refreshTokenEnc) return null;
    const root = await this.folder();
    const id = await this.subfolder(root, project);
    type F = { id: string; name: string; mimeType: string; size?: string; createdTime?: string; videoMediaMetadata?: { durationMillis?: string } };
    const children = async (parent: string): Promise<F[]> => {
      const q = `'${parent}' in parents and trashed=false`;
      const res = await this.api<{ files?: F[] }>('GET', `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime,videoMediaMetadata(durationMillis))&orderBy=createdTime desc&pageSize=1000`);
      return res.files ?? [];
    };
    const video = (f: F): DriveVideo => ({ id: f.id, name: f.name.replace(/\.(mp4|mov|m4v|webm)$/i, ''), bytes: Number(f.size ?? 0), createdAt: f.createdTime ? Date.parse(f.createdTime) : 0, seconds: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null });
    const isVideo = (f: F) => f.mimeType.startsWith('video/');
    const top = await children(id);
    const groups: DriveListing['groups'] = [];
    for (const folder of top.filter((f) => f.mimeType === 'application/vnd.google-apps.folder').sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
      groups.push({ name: folder.name, videos: (await children(folder.id)).filter(isVideo).map(video) });
    }
    groups.push({ name: null, videos: top.filter(isVideo).map(video) });
    return { project, url: `https://drive.google.com/drive/folders/${id}`, groups };
  }

  /** Vídeo do Drive para a página dos replays (com Range: dá para avançar e voltar). Só arquivos que o Estúdio criou. */
  async stream(fileId: string, range: string | undefined): Promise<Response> {
    if (!/^[\w-]{10,128}$/.test(fileId)) throw new Error('Arquivo inválido.');
    return this.deps.fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${await this.token()}`, ...(range && /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {}) } });
  }

  async setFolder(name: string): Promise<DriveState> {
    const folderName = name.replace(/[\u0000-\u001f/\\]+/g, ' ').trim().slice(0, 100) || DEFAULT_FOLDER;
    const s = await this.load();
    if (!s) throw new Error('Cadastre primeiro a chave do Google Drive.');
    if (folderName !== s.folderName) await this.save({ ...s, folderName, folderId: null });
    return this.state();
  }

  async disconnect(): Promise<DriveState> {
    const s = await this.load();
    if (s) await this.save({ ...s, refreshTokenEnc: null, email: null, folderId: null });
    this.access = null;
    return this.state();
  }

  cancel(): void {
    this.pending?.();
  }

  async connect(timeoutMs = 5 * 60_000): Promise<DriveState> {
    const s = await this.load();
    if (!s?.clientId) throw new Error('Cadastre primeiro o ID e a chave secreta do cliente OAuth.');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
      let port = 0;
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/') return void res.writeHead(404).end();
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset=utf-8><body style="font-family:-apple-system,sans-serif;background:#0b0c0e;color:#f1f2f4;padding:40px"><h2>${ok ? 'Google Drive conectado' : 'Não foi possível conectar'}</h2><p>${ok ? 'Pode fechar esta aba e voltar ao Estúdio ao Vivo.' : 'Volte ao Estúdio e tente de novo.'}</p>`);
        clearTimeout(timer);
        server.close();
        if (ok) resolve({ code: url.searchParams.get('code')!, redirect: `http://127.0.0.1:${port}` });
        else reject(new Error(url.searchParams.get('error') === 'access_denied' ? 'O acesso não foi autorizado no Google.' : 'Resposta inválida do Google.'));
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('O login no Google não foi concluído a tempo.')); }, timeoutMs);
      this.pending = () => { clearTimeout(timer); server.close(); reject(new Error('Login cancelado.')); };
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        const params = new URLSearchParams({ client_id: s.clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state });
        void Promise.resolve(this.deps.openBrowser(`${AUTH_URL}?${params}`)).catch(reject);
      });
    }).finally(() => { this.pending = null; });
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
    if (!tokens.refresh_token) throw new Error('O Google não devolveu acesso permanente. Tente conectar de novo.');
    this.access = { token: tokens.access_token, expires: Date.now() + (tokens.expires_in - 60) * 1000 };
    const about = await this.api<{ user?: { emailAddress?: string } }>('GET', `${API}/about?fields=user(emailAddress)`).catch(() => ({ user: undefined }));
    await this.save({ ...s, refreshTokenEnc: this.deps.vault.encrypt(tokens.refresh_token), email: about.user?.emailAddress ?? null, folderId: null });
    return this.state();
  }

  private async tokenRequest(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const s = (await this.load())!;
    const body = new URLSearchParams({ client_id: s.clientId, client_secret: this.deps.vault.decrypt(s.clientSecretEnc), ...params });
    const res = await this.deps.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(res.status, json));
    return json as { access_token: string; expires_in: number; refresh_token?: string };
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expires > Date.now()) return this.access.token;
    const s = await this.load();
    if (!s?.refreshTokenEnc) throw new Error('Conecte o Google Drive em Configurações › Google Drive.');
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.deps.vault.decrypt(s.refreshTokenEnc) });
      this.access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
      return t.access_token;
    } catch (e) {
      if (/expirou ou foi revogado/.test(message(e))) await this.save({ ...s, refreshTokenEnc: null });
      throw e;
    }
  }

  private async api<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.deps.fetch(url, { method, headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(res.status, json));
    return json as T;
  }

  /** Pasta do Estúdio no Drive: a guardada (se ainda existir), uma com o mesmo nome criada pelo app, ou uma nova. */
  private async folder(): Promise<string> {
    const s = (await this.load())!;
    if (s.folderId) {
      const f = await this.api<{ trashed?: boolean }>('GET', `${API}/files/${encodeURIComponent(s.folderId)}?fields=id,trashed`).catch(() => null);
      if (f && !f.trashed) return s.folderId;
    }
    const q = `mimeType='application/vnd.google-apps.folder' and name='${s.folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed=false`;
    const found = await this.api<{ files?: { id: string }[] }>('GET', `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
    const id = found.files?.[0]?.id ?? (await this.api<{ id: string }>('POST', `${API}/files?fields=id`, { name: s.folderName, mimeType: 'application/vnd.google-apps.folder' })).id;
    await this.save({ ...s, folderId: id });
    return id;
  }

  /**
   * Pasta com o nome da pasta do replay no Estúdio, dentro da pasta principal: a que o app já criou com esse
   * nome (mesmo enviada antes) ou uma nova.
   */
  private async subfolder(parent: string, name: string): Promise<string> {
    const clean = name.replace(/[\u0000-\u001f/\\]+/g, ' ').trim().slice(0, 100) || 'Pasta';
    const quoted = clean.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `mimeType='application/vnd.google-apps.folder' and name='${quoted}' and '${parent}' in parents and trashed=false`;
    const found = await this.api<{ files?: { id: string }[] }>('GET', `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
    return found.files?.[0]?.id ?? (await this.api<{ id: string }>('POST', `${API}/files?fields=id`, { name: clean, mimeType: 'application/vnd.google-apps.folder', parents: [parent] })).id;
  }

  /**
   * Envia os arquivos para a pasta do Estúdio (dentro da pasta do projeto, quando informado), um de cada vez.
   * Replay que está numa pasta do Estúdio vai para uma pasta com o mesmo nome dentro dela. Um que falha não impede os outros.
   */
  async upload(files: { path: string; name: string; folder?: string | null }[], progress: (done: number, total: number, name: string) => void, project: string | null = null): Promise<DriveUploadResult[]> {
    // Pasta principal › pasta do projeto (nome do projeto) › pasta do replay.
    const main = await this.folder();
    const root = project ? await this.subfolder(main, project) : main;
    const subs = new Map<string, Promise<string>>();
    const results: DriveUploadResult[] = [];
    for (const [i, f] of files.entries()) {
      progress(i, files.length, f.name);
      try {
        let parent = root;
        if (f.folder) {
          // A mesma pasta é procurada/criada uma vez só por envio (se falhar, tenta de novo no próximo arquivo).
          let sub = subs.get(f.folder);
          if (!sub) {
            sub = this.subfolder(root, f.folder);
            subs.set(f.folder, sub);
            sub.catch(() => subs.delete(f.folder!));
          }
          parent = await sub;
        }
        const size = (await stat(f.path)).size;
        if (size > MAX_BYTES) throw new Error('arquivo maior que 1 GB');
        const start = await this.deps.fetch(`${UPLOAD}?uploadType=resumable&fields=id,webViewLink`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
          body: JSON.stringify({ name: cleanName(f.name), parents: [parent] }),
        });
        if (!start.ok) throw new Error(explain(start.status, await start.json().catch(() => ({}))));
        const location = start.headers.get('location');
        if (!location?.startsWith('https://www.googleapis.com/')) throw new Error('o Google não devolveu o endereço de envio');
        const put = await this.deps.fetch(location, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: await readFile(f.path) });
        const json = await put.json().catch(() => ({})) as { id?: string; webViewLink?: string };
        if (!put.ok || !json.id) throw new Error(explain(put.status, json));
        results.push({ name: f.name, ok: true, link: json.webViewLink ?? null, error: null });
      } catch (e) {
        results.push({ name: f.name, ok: false, link: null, error: message(e) });
      }
    }
    progress(files.length, files.length, '');
    return results;
  }
}
