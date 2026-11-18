import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { LiveChatMessage, YoutubeBroadcast, YoutubeNewBroadcast, YoutubeState } from '../../src/types/studio';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
/** Permissão para ver e gerenciar as transmissões do canal (criar, listar, ligar a chave). */
const SCOPE = 'https://www.googleapis.com/auth/youtube';
/** Nome do stream reutilizável que o Estúdio cria no canal (a "chave" que ele usa). */
const STREAM_TITLE = 'Estúdio ao Vivo';
/** Canal que já existia antes da lista de canais (o destino dele continua sendo "youtube-conta"). */
export const PRIMARY_ID = 'principal';

/** Criptografia do Keychain (injetada para poder testar sem o Electron). */
export interface Vault {
  encrypt(text: string): string;
  decrypt(data: string): string;
}

export interface Stored {
  clientId: string;
  clientSecretEnc: string;
  refreshTokenEnc: string | null;
  channel: { id: string; title: string; thumbnail: string | null } | null;
  /** Live escolhida em "Usar esta" (para conferir se ela ainda pode receber vídeo). */
  broadcast?: { id: string; title: string } | null;
}

/** Onde a conta fica guardada: um arquivo só dela (testes, versões antigas) ou uma entrada da lista de canais. */
export interface AccountStore {
  read(): Promise<Stored | null>;
  write(stored: Stored | null): Promise<void>;
}

export function fileStore(file: string): AccountStore {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as Stored;
      } catch {
        return null;
      }
    },
    async write(stored) {
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, file);
    },
  };
}

export interface YoutubeDeps {
  /** Canal na lista de canais do Estúdio. */
  id?: string;
  /** Arquivo próprio da conta (ou store, quando a conta faz parte da lista de canais). */
  file?: string;
  store?: AccountStore;
  vault: Vault;
  fetch: typeof fetch;
  /** Abre o navegador do Mac na página de login do Google. */
  openBrowser: (url: string) => Promise<void> | void;
  /** Avisa a sincronização com a conta do Estúdio quando algo muda. */
  onChange?: () => void;
}

/** Conta do YouTube como vai para a conta do Estúdio na nuvem (segredos abertos, protegidos pela conta). */
export interface PortableYoutube {
  /** Canal na lista de canais do Estúdio (ausente em cópias de versões antigas = canal principal). */
  id?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
  channel: Stored['channel'];
  broadcast: Stored['broadcast'] | null;
}

/** Conta guardada (segredos no Keychain) → cópia com os segredos abertos. null = nada para levar. */
export function portableFromStored(s: Stored | null, vault: Vault): PortableYoutube | null {
  if (!s?.clientId) return null;
  try {
    return { clientId: s.clientId, clientSecret: vault.decrypt(s.clientSecretEnc), refreshToken: s.refreshTokenEnc ? vault.decrypt(s.refreshTokenEnc) : null, channel: s.channel ?? null, broadcast: s.broadcast ?? null };
  } catch {
    // Segredo de outro Keychain que não abre aqui.
    return null;
  }
}

const validChannel = (c: unknown): Stored['channel'] => {
  const x = c as Stored['channel'];
  return x && typeof x.id === 'string' && typeof x.title === 'string' ? { id: x.id.slice(0, 64), title: x.title.slice(0, 200), thumbnail: typeof x.thumbnail === 'string' && x.thumbnail.startsWith('https://') ? x.thumbnail : null } : null;
};

/** Cópia com segredos abertos → conta guardada aqui (segredos de volta no Keychain). Inválida = null. */
export function storedFromPortable(raw: unknown, vault: Vault): Stored | null {
  const p = raw as Partial<PortableYoutube> | null;
  const valid = p && typeof p.clientId === 'string' && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(p.clientId) && typeof p.clientSecret === 'string' && p.clientSecret.length <= 200;
  if (!valid) return null;
  const b = p.broadcast as Stored['broadcast'];
  return {
    clientId: p.clientId!,
    clientSecretEnc: vault.encrypt(p.clientSecret!),
    refreshTokenEnc: typeof p.refreshToken === 'string' && p.refreshToken && p.refreshToken.length <= 2000 ? vault.encrypt(p.refreshToken) : null,
    channel: validChannel(p.channel),
    broadcast: b && typeof b.id === 'string' && /^[\w-]{5,64}$/.test(b.id) && typeof b.title === 'string' ? { id: b.id, title: b.title.slice(0, 200) } : null,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Mensagens do Google traduzidas para o que o operador precisa fazer. */
function explain(status: number, body: unknown): string {
  const err = (body as { error?: { message?: string; errors?: { reason?: string }[] } | string; error_description?: string })?.error;
  const reason = typeof err === 'object' ? err?.errors?.[0]?.reason : undefined;
  const text = typeof err === 'object' ? err?.message : (body as { error_description?: string })?.error_description ?? err;
  if (reason === 'liveStreamingNotEnabled') return 'Este canal ainda não pode transmitir ao vivo. Ative em studio.youtube.com → Criar → Transmitir ao vivo (a liberação leva até 24 h).';
  if (reason === 'quotaExceeded') return 'O limite diário da API do YouTube acabou. Tente amanhã ou aumente a cota no Google Cloud.';
  if (reason === 'insufficientPermissions' || status === 403) return `O YouTube recusou o pedido: ${text ?? 'sem permissão'}.`;
  if (text === 'invalid_grant') return 'O acesso à conta expirou ou foi revogado. Conecte a conta de novo.';
  if (text === 'invalid_client') return 'ID ou chave secreta do cliente OAuth inválidos. Confira no Google Cloud.';
  return `YouTube: ${text ?? `erro ${status}`}`;
}

/**
 * Conta do YouTube pela API oficial. O login é feito no navegador do Mac (OAuth com PKCE, retorno em
 * 127.0.0.1); o token de acesso e a chave do stream ficam só aqui, criptografados no Keychain.
 */
export class YoutubeAccount {
  private stored: Stored | null = null;
  private access: { token: string; expires: number } | null = null;
  /** Login em andamento (para o botão Cancelar). */
  private pending: (() => void) | null = null;

  cancel(): void {
    this.pending?.();
  }

  private store: AccountStore;

  constructor(private deps: YoutubeDeps) {
    if (!deps.store && !deps.file) throw new Error('Conta do YouTube sem lugar para guardar.');
    this.store = deps.store ?? fileStore(deps.file!);
  }

  private async load(): Promise<Stored | null> {
    if (this.stored) return this.stored;
    this.stored = await this.store.read();
    return this.stored;
  }

  private async save(stored: Stored | null): Promise<void> {
    this.stored = stored;
    await this.store.write(stored);
    this.deps.onChange?.();
  }

  async exportPortable(): Promise<PortableYoutube | null> {
    return portableFromStored(await this.load(), this.deps.vault);
  }

  /** Da nuvem para este Mac (segredos de volta no Keychain daqui). Não avisa a sincronização: veio dela. */
  async importPortable(raw: unknown): Promise<void> {
    this.access = null;
    this.stored = storedFromPortable(raw, this.deps.vault);
    await this.store.write(this.stored);
  }

  async state(): Promise<YoutubeState> {
    const s = await this.load();
    return { id: this.deps.id ?? PRIMARY_ID, configured: Boolean(s?.clientId), connected: Boolean(s?.refreshTokenEnc), channel: s?.channel ?? null, clientId: s?.clientId ?? '' };
  }

  /** Credenciais do cliente OAuth (tipo "App para computador") criado no Google Cloud do operador. */
  async setClient(clientId: string, clientSecret: string): Promise<YoutubeState> {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('ID do cliente inválido: deve terminar em .apps.googleusercontent.com.');
    if (!/^[\w-]{10,100}$/.test(secret)) throw new Error('Chave secreta do cliente inválida.');
    await this.save({ clientId: id, clientSecretEnc: this.deps.vault.encrypt(secret), refreshTokenEnc: null, channel: null });
    this.access = null;
    return this.state();
  }

  async disconnect(): Promise<YoutubeState> {
    const s = await this.load();
    if (s) await this.save({ ...s, refreshTokenEnc: null, channel: null });
    this.access = null;
    return this.state();
  }

  /** Login no navegador: espera o Google devolver o código em http://127.0.0.1:<porta> e troca por tokens. */
  async connect(timeoutMs = 5 * 60_000): Promise<YoutubeState> {
    const s = await this.load();
    if (!s?.clientId) throw new Error('Informe primeiro o ID e a chave secreta do cliente OAuth.');
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
        res.end(`<!doctype html><meta charset=utf-8><body style="font-family:-apple-system,sans-serif;background:#0b0c0e;color:#f1f2f4;padding:40px"><h2>${ok ? 'Conta do YouTube conectada' : 'Não foi possível conectar'}</h2><p>${ok ? 'Pode fechar esta aba e voltar ao Estúdio ao Vivo.' : 'Volte ao Estúdio e tente de novo.'}</p>`);
        clearTimeout(timer);
        server.close();
        if (ok) resolve({ code: url.searchParams.get('code')!, redirect: `http://127.0.0.1:${port}` });
        else reject(new Error(url.searchParams.get('error') === 'access_denied' ? 'O acesso não foi autorizado no Google.' : 'Resposta inválida do Google.'));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('O login no Google não foi concluído a tempo.'));
      }, timeoutMs);
      this.pending = () => {
        clearTimeout(timer);
        server.close();
        reject(new Error('Login cancelado.'));
      };
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        const params = new URLSearchParams({
          client_id: s.clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
        void Promise.resolve(this.deps.openBrowser(`${AUTH_URL}?${params}`)).catch(reject);
      });
    });

    this.pending = null;
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect });
    if (!tokens.refresh_token) throw new Error('O Google não devolveu acesso permanente. Tente conectar de novo.');
    this.access = { token: tokens.access_token, expires: Date.now() + (tokens.expires_in - 60) * 1000 };
    const channels = await this.api<{ items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[] }>('GET', 'channels?part=snippet&mine=true');
    const channel = channels.items?.[0];
    await this.save({ ...s, refreshTokenEnc: this.deps.vault.encrypt(tokens.refresh_token), channel: channel ? { id: channel.id, title: channel.snippet.title, thumbnail: channel.snippet.thumbnails?.default?.url ?? null } : null });
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
    if (!s?.refreshTokenEnc) throw new Error('Conecte a conta do YouTube.');
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.deps.vault.decrypt(s.refreshTokenEnc) });
      this.access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
      return t.access_token;
    } catch (e) {
      if (/expirou ou foi revogado/.test(message(e))) await this.save({ ...s, refreshTokenEnc: null });
      throw e;
    }
  }

  private async api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await this.deps.fetch(`${API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(res.status, json));
    return json as T;
  }

  /** Lives programadas e as que estão no ar agora, das mais próximas para as mais distantes. */
  async broadcasts(): Promise<YoutubeBroadcast[]> {
    type Item = { id: string; snippet: { title: string; description: string; scheduledStartTime?: string; thumbnails?: { medium?: { url: string } } }; status: { lifeCycleStatus: string; privacyStatus: string }; contentDetails?: { boundStreamId?: string } };
    const [upcoming, active] = await Promise.all(['upcoming', 'active'].map((status) =>
      this.api<{ items?: Item[] }>('GET', `liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=${status}&broadcastType=all&maxResults=50`)));
    return [...(active.items ?? []), ...(upcoming.items ?? [])]
      .map((b) => ({
        id: b.id,
        title: b.snippet.title,
        description: b.snippet.description,
        scheduledStart: b.snippet.scheduledStartTime ?? null,
        status: b.status.lifeCycleStatus,
        privacy: b.status.privacyStatus as YoutubeBroadcast['privacy'],
        thumbnail: b.snippet.thumbnails?.medium?.url ?? null,
        url: `https://www.youtube.com/watch?v=${b.id}`,
      }))
      .sort((a, b) => (a.status === 'live' ? -1 : 0) - (b.status === 'live' ? -1 : 0) || (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''));
  }

  /** Cria a live no canal. Começa sozinha quando o vídeo chegar e termina quando parar. */
  async create(input: YoutubeNewBroadcast): Promise<YoutubeBroadcast> {
    const title = input.title.trim().slice(0, 100);
    if (!title) throw new Error('Informe o título da transmissão.');
    const start = new Date(input.scheduledStart);
    if (Number.isNaN(start.getTime())) throw new Error('Data e hora inválidas.');
    const created = await this.api<{ id: string }>('POST', 'liveBroadcasts?part=snippet,status,contentDetails', {
      snippet: { title, description: input.description.slice(0, 5000), scheduledStartTime: start.toISOString() },
      status: { privacyStatus: input.privacy, selfDeclaredMadeForKids: false },
      // Sem parada automática: uma queda curta do envio não pode encerrar a live (só o operador encerra).
      contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: 'low', enableDvr: true, monitorStream: { enableMonitorStream: false } },
    });
    const list = await this.broadcasts();
    return list.find((b) => b.id === created.id) ?? { id: created.id, title, description: input.description, scheduledStart: start.toISOString(), status: 'created', privacy: input.privacy, thumbnail: null, url: `https://www.youtube.com/watch?v=${created.id}` };
  }

  /**
   * Prepara uma live para receber o vídeo do Estúdio: usa (ou cria) o stream "Estúdio ao Vivo" do canal,
   * liga os dois e devolve o endereço com a chave — que fica só no processo principal.
   */
  async prepare(broadcastId: string): Promise<{ server: string; key: string; title: string }> {
    type Stream = { id: string; snippet: { title: string }; cdn: { ingestionInfo: { rtmpsIngestionAddress?: string; ingestionAddress: string; streamName: string } } };
    const streams = await this.api<{ items?: Stream[] }>('GET', 'liveStreams?part=snippet,cdn&mine=true&maxResults=50');
    let stream = streams.items?.find((s) => s.snippet.title === STREAM_TITLE);
    if (!stream) {
      stream = await this.api<Stream>('POST', 'liveStreams?part=snippet,cdn,contentDetails', {
        snippet: { title: STREAM_TITLE },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: true },
      });
    }
    const bound = await this.api<{ snippet: { title: string } }>('POST', `liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&part=id,snippet,contentDetails&streamId=${encodeURIComponent(stream.id)}`);
    const s = await this.load();
    if (s) await this.save({ ...s, broadcast: { id: broadcastId, title: bound.snippet.title } });
    const info = stream.cdn.ingestionInfo;
    return { server: info.rtmpsIngestionAddress ?? info.ingestionAddress, key: info.streamName, title: bound.snippet.title };
  }

  /**
   * A live que vai receber o vídeo do Estúdio e a situação dela no YouTube. Sem live guardada (escolhida
   * numa versão anterior), procura a mais recente ligada ao stream "Estúdio ao Vivo".
   */
  async target(): Promise<{ id: string; title: string; status: string | null } | null> {
    const s = await this.load();
    if (!s?.refreshTokenEnc) return null;
    if (s.broadcast) return { ...s.broadcast, status: await this.lifeCycle(s.broadcast.id) };
    type Stream = { id: string; snippet: { title: string } };
    const streams = await this.api<{ items?: Stream[] }>('GET', 'liveStreams?part=snippet&mine=true&maxResults=50');
    const stream = streams.items?.find((x) => x.snippet.title === STREAM_TITLE);
    if (!stream) return null;
    type Item = { id: string; snippet: { title: string; publishedAt?: string; scheduledStartTime?: string; actualStartTime?: string }; status: { lifeCycleStatus: string }; contentDetails?: { boundStreamId?: string } };
    const all = await this.api<{ items?: Item[] }>('GET', 'liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=all&broadcastType=all&maxResults=50');
    const when = (b: Item) => b.snippet.actualStartTime ?? b.snippet.scheduledStartTime ?? b.snippet.publishedAt ?? '';
    const latest = (all.items ?? []).filter((b) => b.contentDetails?.boundStreamId === stream.id).sort((a, b) => when(b).localeCompare(when(a)))[0];
    return latest ? { id: latest.id, title: latest.snippet.title, status: latest.status.lifeCycleStatus } : null;
  }

  /**
   * Números da live: pessoas assistindo agora, chat ativo e saúde do sinal que chega ao YouTube
   * (3 unidades da cota por chamada).
   */
  async liveDetails(broadcastId: string): Promise<{ status: string | null; viewers: number | null; likes: number | null; chatId: string | null; health: string | null; issues: string[] }> {
    const id = encodeURIComponent(broadcastId);
    type B = { status: { lifeCycleStatus: string }; snippet: { liveChatId?: string }; contentDetails?: { boundStreamId?: string } };
    type V = { liveStreamingDetails?: { concurrentViewers?: string; activeLiveChatId?: string }; statistics?: { likeCount?: string } };
    const [b, v] = await Promise.all([
      this.api<{ items?: B[] }>('GET', `liveBroadcasts?part=status,snippet,contentDetails&id=${id}`),
      this.api<{ items?: V[] }>('GET', `videos?part=liveStreamingDetails,statistics&id=${id}`),
    ]);
    const broadcast = b.items?.[0];
    const details = v.items?.[0]?.liveStreamingDetails;
    let health: string | null = null;
    let issues: string[] = [];
    const streamId = broadcast?.contentDetails?.boundStreamId;
    if (streamId) {
      type S = { status?: { healthStatus?: { status?: string; configurationIssues?: { severity?: string; reason?: string; description?: string }[] } } };
      const s = await this.api<{ items?: S[] }>('GET', `liveStreams?part=status&id=${encodeURIComponent(streamId)}`).catch(() => null);
      const hs = s?.items?.[0]?.status?.healthStatus;
      health = hs?.status ?? null;
      issues = (hs?.configurationIssues ?? []).filter((i) => i.severity !== 'info').map((i) => i.description ?? i.reason ?? '').filter(Boolean).slice(0, 3);
    }
    return {
      status: broadcast?.status.lifeCycleStatus ?? null,
      viewers: details?.concurrentViewers !== undefined ? Number(details.concurrentViewers) : null,
      // Curtidas da live (some se o canal esconder a contagem).
      likes: v.items?.[0]?.statistics?.likeCount !== undefined ? Number(v.items[0].statistics.likeCount) : null,
      chatId: details?.activeLiveChatId ?? broadcast?.snippet.liveChatId ?? null,
      health,
      issues,
    };
  }

  /** Mensagens novas do chat ao vivo desde a última página lida (o YouTube diz quando perguntar de novo). */
  async chatMessages(chatId: string, pageToken: string | null): Promise<{ messages: LiveChatMessage[]; next: string | null; waitMs: number }> {
    type M = { id: string; snippet: { type: string; publishedAt: string; displayMessage?: string; superChatDetails?: { amountDisplayString?: string } }; authorDetails: { displayName: string; profileImageUrl?: string; isChatOwner?: boolean; isChatModerator?: boolean } };
    const res = await this.api<{ items?: M[]; nextPageToken?: string; pollingIntervalMillis?: number }>('GET', `liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails&maxResults=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    const messages = (res.items ?? [])
      .filter((m) => m.snippet.displayMessage)
      .map((m) => ({
        id: m.id,
        author: m.authorDetails.displayName,
        avatar: m.authorDetails.profileImageUrl ?? null,
        text: m.snippet.displayMessage!,
        at: m.snippet.publishedAt,
        role: m.authorDetails.isChatOwner ? 'dono' as const : m.authorDetails.isChatModerator ? 'moderador' as const : null,
        amount: m.snippet.superChatDetails?.amountDisplayString ?? null,
      }));
    return { messages, next: res.nextPageToken ?? null, waitMs: res.pollingIntervalMillis ?? 5000 };
  }

  /**
   * Desliga a "parada automática" da live: com ela ligada, o YouTube encerra a live de vez quando o envio
   * para por alguns instantes (internet oscilou, reconexão), e ela não aceita mais vídeo.
   */
  async keepOpen(broadcastId: string): Promise<boolean> {
    type CD = { id: string; contentDetails: Record<string, unknown> & { enableAutoStop?: boolean; monitorStream?: Record<string, unknown> } };
    const res = await this.api<{ items?: CD[] }>('GET', `liveBroadcasts?part=contentDetails&id=${encodeURIComponent(broadcastId)}`);
    const item = res.items?.[0];
    if (!item) return false;
    if (item.contentDetails.enableAutoStop === false) return true;
    const cd = item.contentDetails;
    // O YouTube exige reenviar os campos de contentDetails (os que faltam voltam ao padrão).
    const monitor = (cd.monitorStream ?? {}) as { enableMonitorStream?: boolean; broadcastStreamDelayMs?: number };
    await this.api('PUT', 'liveBroadcasts?part=contentDetails', {
      id: broadcastId,
      contentDetails: {
        enableAutoStart: cd.enableAutoStart ?? true,
        enableAutoStop: false,
        enableDvr: cd.enableDvr ?? true,
        enableEmbed: cd.enableEmbed,
        recordFromStart: cd.recordFromStart ?? true,
        enableClosedCaptions: cd.enableClosedCaptions,
        enableContentEncryption: cd.enableContentEncryption,
        startWithSlate: cd.startWithSlate,
        latencyPreference: cd.latencyPreference,
        monitorStream: { enableMonitorStream: monitor.enableMonitorStream ?? false, ...(monitor.enableMonitorStream ? { broadcastStreamDelayMs: monitor.broadcastStreamDelayMs ?? 0 } : {}) },
      },
    });
    return true;
  }

  /** Encerra a live no YouTube (o vídeo fica salvo no canal). */
  async complete(broadcastId: string): Promise<void> {
    await this.api('POST', `liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(broadcastId)}&part=status`);
  }

  /** Situação da live no YouTube (para mostrar "No ar no YouTube"). */
  async lifeCycle(broadcastId: string): Promise<string | null> {
    const res = await this.api<{ items?: { status: { lifeCycleStatus: string } }[] }>('GET', `liveBroadcasts?part=status&id=${encodeURIComponent(broadcastId)}`);
    return res.items?.[0]?.status.lifeCycleStatus ?? null;
  }
}
