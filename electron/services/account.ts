/**
 * Conta do Estúdio ao Vivo (Supabase Auth + uma linha por usuário com tudo o que ele configurou).
 * Roda só no processo principal: a senha, os tokens e as chaves nunca passam pela interface.
 * Usa fetch direto com prazo (o cliente oficial às vezes ficava pendurado sem responder).
 */

export interface CloudConfig {
  url: string;
  anonKey: string;
}

export interface StoredSession {
  userId: string;
  email: string;
  refreshToken: string;
}

export interface SessionStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession | null): Promise<void>;
}

/** Tudo o que a pessoa configurou, no formato que vai para a nuvem (chaves em texto, protegidas pelo RLS). */
export interface CloudData {
  preferences: unknown;
  project: unknown;
  destinations: unknown[];
  youtube: unknown;
}

export interface CloudRow {
  data: CloudData;
  updatedAt: string;
  device: string | null;
}

const TIMEOUT_MS = 15_000;
export const TABLE = 'studio_user_data';

/** Mensagens do Supabase traduzidas para quem está entrando. */
export function explainAuth(status: number, body: unknown): string {
  const b = (body ?? {}) as { error_code?: string; code?: string; msg?: string; message?: string; error_description?: string; error?: string };
  const code = b.error_code ?? b.code ?? b.error ?? '';
  const text = b.msg ?? b.message ?? b.error_description ?? '';
  if (code === 'invalid_credentials' || code === 'invalid_grant' || /invalid login credentials/i.test(text)) return 'E-mail ou senha incorretos.';
  if (code === 'email_not_confirmed') return 'Confirme o e-mail pelo link que chegou na sua caixa de entrada.';
  if (code === 'user_already_exists' || /already registered/i.test(text)) return 'Já existe uma conta com este e-mail. Use Entrar.';
  if (code === 'weak_password' || /password/i.test(text)) return 'Senha fraca: use pelo menos 6 caracteres.';
  if (code === 'over_request_rate_limit' || status === 429) return 'Muitas tentativas. Espere um minuto e tente de novo.';
  if (status >= 500) return 'O servidor das contas não respondeu. Tente de novo em instantes.';
  return text || `Não foi possível entrar (erro ${status}).`;
}

const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;

export class CloudAccount {
  private session: (StoredSession & { accessToken: string; expiresAt: number }) | null = null;

  constructor(
    private config: CloudConfig | null,
    private store: SessionStore,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  get configured(): boolean {
    return Boolean(this.config?.url && this.config.anonKey);
  }

  current(): { userId: string; email: string } | null {
    return this.session ? { userId: this.session.userId, email: this.session.email } : null;
  }

  private async request(path: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; body: unknown }> {
    if (!this.config) throw new Error('O servidor das contas ainda não foi configurado neste aplicativo.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetcher(`${this.config.url}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${init.token ?? this.config.anonKey}`,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, body };
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw new Error('Sem resposta do servidor das contas (internet?).');
      throw new Error('Sem conexão com o servidor das contas. Confira a internet.');
    } finally {
      clearTimeout(timer);
    }
  }

  private async useTokens(body: unknown): Promise<{ userId: string; email: string }> {
    const t = body as { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email: string } };
    if (!t?.access_token || !t.user?.id) throw new Error('Resposta inesperada do servidor das contas.');
    this.session = { userId: t.user.id, email: t.user.email, refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
    await this.store.write({ userId: t.user.id, email: t.user.email, refreshToken: t.refresh_token });
    return { userId: t.user.id, email: t.user.email };
  }

  async login(email: string, password: string): Promise<{ userId: string; email: string }> {
    const e = email.trim().toLowerCase();
    if (!validEmail(e)) throw new Error('Digite um e-mail válido.');
    if (!password) throw new Error('Digite a senha.');
    const { status, body } = await this.request('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: e, password }) });
    if (status !== 200) throw new Error(explainAuth(status, body));
    return this.useTokens(body);
  }

  async signup(email: string, password: string): Promise<{ userId: string; email: string }> {
    const e = email.trim().toLowerCase();
    if (!validEmail(e)) throw new Error('Digite um e-mail válido.');
    if (password.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
    const { status, body } = await this.request('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email: e, password }) });
    if (status !== 200) throw new Error(explainAuth(status, body));
    if (!(body as { access_token?: string })?.access_token) throw new Error('Conta criada. Confirme o e-mail pelo link que chegou na sua caixa de entrada e depois entre.');
    return this.useTokens(body);
  }

  /** Volta à sessão salva neste computador (sem pedir a senha). Sem internet, entra com os dados locais. */
  async restore(): Promise<{ userId: string; email: string; offline: boolean } | null> {
    const saved = await this.store.read();
    if (!saved) return null;
    try {
      const { status, body } = await this.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: saved.refreshToken }) });
      if (status !== 200) {
        // Sessão recusada (senha trocada, conta removida): pede login de novo.
        if (status === 400 || status === 401 || status === 403) await this.store.write(null);
        return status >= 500 ? { userId: saved.userId, email: saved.email, offline: true } : null;
      }
      return { ...(await this.useTokens(body)), offline: false };
    } catch {
      // Sem internet: segue com o que está salvo neste Mac; sincroniza quando voltar.
      this.session = { ...saved, accessToken: '', expiresAt: 0 };
      return { userId: saved.userId, email: saved.email, offline: true };
    }
  }

  async logout(): Promise<void> {
    const token = this.session?.accessToken;
    this.session = null;
    await this.store.write(null);
    if (token) await this.request('/auth/v1/logout', { method: 'POST', token }).catch(() => undefined);
  }

  private async token(): Promise<string> {
    if (!this.session) throw new Error('Entre na sua conta.');
    if (this.session.accessToken && Date.now() < this.session.expiresAt) return this.session.accessToken;
    const { status, body } = await this.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: this.session.refreshToken }) });
    if (status !== 200) throw new Error(explainAuth(status, body));
    await this.useTokens(body);
    return this.session.accessToken;
  }

  async pull(): Promise<CloudRow | null> {
    const token = await this.token();
    const { status, body } = await this.request(`/rest/v1/${TABLE}?select=data,updated_at,device&user_id=eq.${this.session!.userId}`, { token });
    if (status !== 200) throw new Error(`Não deu para baixar suas configurações (erro ${status}).`);
    const row = (body as { data: CloudData; updated_at: string; device: string | null }[])[0];
    return row ? { data: row.data, updatedAt: row.updated_at, device: row.device } : null;
  }

  async push(data: CloudData, device: string): Promise<string> {
    const token = await this.token();
    const updatedAt = new Date().toISOString();
    const { status, body } = await this.request(`/rest/v1/${TABLE}?on_conflict=user_id`, {
      method: 'POST',
      token,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: this.session!.userId, data, updated_at: updatedAt, device }),
    });
    if (status !== 201 && status !== 200 && status !== 204) throw new Error(`Não deu para salvar suas configurações na nuvem (erro ${status}: ${JSON.stringify(body).slice(0, 120)}).`);
    return updatedAt;
  }
}
