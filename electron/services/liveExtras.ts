import type { LiveChatMessage, LiveExtras } from '../../src/types/studio';
import type { YoutubeAccount } from './youtube';

/** Números da live (pessoas online e saúde do sinal): 3 unidades da cota a cada leitura. */
const STATS_EVERY_MS = 20_000;
/** O chat nunca é lido mais rápido que isso, mesmo que o YouTube permita (cota diária de 10 mil unidades). */
const CHAT_MIN_MS = 8_000;
const CHAT_KEEP = 150;

const EMPTY: LiveExtras = { available: false, title: null, status: null, viewers: null, likes: null, health: null, issues: [], chat: [], chatError: null, error: null };

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Acompanha a live do YouTube para o painel do operador: pessoas assistindo, saúde do sinal e comentários.
 * Só lê o que estiver ligado na barra do programa, e para tudo quando nada está ligado.
 */
export class LiveExtrasWatcher {
  private state: LiveExtras = { ...EMPTY };
  private opts = { stats: false, chat: false };
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private chatTimer: ReturnType<typeof setTimeout> | null = null;
  private chatId: string | null = null;
  private broadcastId: string | null = null;
  private pageToken: string | null = null;
  private seen = new Set<string>();

  constructor(private youtube: Pick<YoutubeAccount, 'state' | 'target' | 'liveDetails' | 'chatMessages'>, private emit: (state: LiveExtras) => void) {}

  watch(opts: { stats: boolean; chat: boolean }): void {
    const wasStats = this.opts.stats || this.opts.chat;
    const wasChat = this.opts.chat;
    this.opts = opts;
    if (!opts.stats && !opts.chat) {
      this.clear();
      return;
    }
    // O chat depende do id do chat, que vem da leitura dos números: ela roda sempre que algo estiver ligado.
    if (!wasStats) void this.readStats();
    else this.emit(this.state);
    if (opts.chat && !wasChat && this.chatId) void this.readChat();
    if (!opts.chat && this.chatTimer) {
      clearTimeout(this.chatTimer);
      this.chatTimer = null;
    }
  }

  private clear(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.statsTimer = null;
    this.chatTimer = null;
  }

  private update(patch: Partial<LiveExtras>): void {
    this.state = { ...this.state, ...patch };
    this.emit(this.state);
  }

  private async readStats(): Promise<void> {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    if (!this.opts.stats && !this.opts.chat) return;
    try {
      const yt = await this.youtube.state();
      const target = yt.connected ? await this.youtube.target() : null;
      if (!target) {
        this.update({ ...EMPTY, error: yt.connected ? 'Nenhuma live escolhida (⚙️ Transmissão → Conta do YouTube).' : 'Conecte a conta do YouTube em ⚙️ Transmissão.' });
      } else {
        if (target.id !== this.broadcastId) {
          // Outra live: começa o chat do zero.
          this.broadcastId = target.id;
          this.chatId = null;
          this.pageToken = null;
          this.seen.clear();
          this.state = { ...this.state, chat: [] };
        }
        const d = await this.youtube.liveDetails(target.id);
        const newChat = d.chatId && d.chatId !== this.chatId;
        this.chatId = d.chatId;
        this.update({ available: true, title: target.title, status: d.status, viewers: d.viewers, likes: d.likes, health: d.health, issues: d.issues, error: null });
        if (newChat && this.opts.chat) void this.readChat();
      }
    } catch (e) {
      this.update({ error: text(e) });
    }
    if (this.opts.stats || this.opts.chat) this.statsTimer = setTimeout(() => void this.readStats(), STATS_EVERY_MS);
  }

  private async readChat(): Promise<void> {
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.chatTimer = null;
    if (!this.opts.chat || !this.chatId) return;
    let wait = CHAT_MIN_MS;
    try {
      const res = await this.youtube.chatMessages(this.chatId, this.pageToken);
      this.pageToken = res.next;
      wait = Math.max(CHAT_MIN_MS, res.waitMs);
      const fresh: LiveChatMessage[] = res.messages.filter((m) => !this.seen.has(m.id));
      fresh.forEach((m) => this.seen.add(m.id));
      if (fresh.length || this.state.chatError) this.update({ chat: [...this.state.chat, ...fresh].slice(-CHAT_KEEP), chatError: null });
    } catch (e) {
      const msg = text(e);
      // Chat encerrado/desligado: não insiste (a próxima leitura dos números traz um chat novo, se houver).
      if (/liveChatEnded|liveChatDisabled|liveChatNotFound|not found|disabled|ended/i.test(msg)) {
        this.chatId = null;
        this.update({ chatError: 'O chat desta live está desligado ou terminou.' });
        return;
      }
      this.update({ chatError: msg });
      wait = 20_000;
    }
    if (this.opts.chat) this.chatTimer = setTimeout(() => void this.readChat(), wait);
  }
}
