import type { FetchLike } from "./llm";

export interface Gateway {
  sendPresence(chatId: string, ms: number): Promise<void>;
  sendText(chatId: string, text: string): Promise<{ id?: string }>;
}

/** Evolution API v2 client (self-hosted). Only used for replies to chats that messaged us first. */
export class EvolutionGateway implements Gateway {
  constructor(private baseUrl: string, private apiKey: string, private instance: string, private fetchImpl: FetchLike = fetch as unknown as FetchLike) {}
  private post(path: string, body: unknown) {
    return this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}/${encodeURIComponent(this.instance)}`,
      { method: "POST", headers: { "Content-Type": "application/json", apikey: this.apiKey }, body: JSON.stringify(body) });
  }
  async sendPresence(chatId: string, ms: number) {
    await this.post("/chat/sendPresence", { number: chatId, presence: "composing", delay: ms }).catch(() => undefined);
  }
  async sendText(chatId: string, text: string) {
    const r = await this.post("/message/sendText", { number: chatId, text });
    if (!r.ok) throw Object.assign(new Error(`evolution ${r.status}`), { status: r.status });
    const j = await r.json().catch(() => ({}));
    return { id: j?.key?.id };
  }
}

export interface ThrottleConfig {
  perChatGapMs: number; // min gap between messages to the same chat
  globalPerMinute: number; // cap across the number
  typingMsPerChar: number; typingMinMs: number; typingMaxMs: number;
  jitterMs: number;
}
export const DEFAULT_THROTTLE: ThrottleConfig = { perChatGapMs: 1500, globalPerMinute: 20, typingMsPerChar: 25, typingMinMs: 800, typingMaxMs: 4000, jitterMs: 700 };

export interface QueuedMessage { id: string; chatId: string; text: string; attempts: number; notBefore: number }

/**
 * Outbound queue worker. Decides *when* a message may go out (per-chat gap, global
 * rate, human-like typing delay with jitter) and retries gateway failures with backoff.
 * Time and sleep are injected so tests run instantly.
 */
export class ThrottledSender {
  private lastToChat = new Map<string, number>();
  private window: number[] = [];
  constructor(private gw: Gateway, private cfg: ThrottleConfig = DEFAULT_THROTTLE,
    private clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    private rand: () => number = Math.random) {}

  typingDelay(text: string) {
    const base = Math.min(this.cfg.typingMaxMs, Math.max(this.cfg.typingMinMs, text.length * this.cfg.typingMsPerChar));
    return Math.round(base + this.rand() * this.cfg.jitterMs);
  }

  /** ms to wait before this chat may receive the next message */
  waitFor(chatId: string): number {
    const now = this.clock.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    const chatWait = Math.max(0, (this.lastToChat.get(chatId) ?? -Infinity) + this.cfg.perChatGapMs - now);
    const globalWait = this.window.length >= this.cfg.globalPerMinute ? this.window[0] + 60_000 - now : 0;
    return Math.max(chatWait, globalWait);
  }

  /** Send one message honouring all limits. Throws on gateway failure (caller requeues with backoff). */
  async send(m: QueuedMessage) {
    const wait = this.waitFor(m.chatId);
    if (wait > 0) await this.clock.sleep(wait);
    const typing = this.typingDelay(m.text);
    await this.gw.sendPresence(m.chatId, typing);
    await this.clock.sleep(typing);
    await this.gw.sendText(m.chatId, m.text);
    const t = this.clock.now();
    this.lastToChat.set(m.chatId, t); this.window.push(t);
  }
}

/** Fake gateway for tests/simulation: records everything, never touches WhatsApp. */
export class MockGateway implements Gateway {
  sent: { chatId: string; text: string; at: number }[] = [];
  presences: { chatId: string; ms: number }[] = [];
  failNext = 0;
  constructor(private now: () => number = Date.now) {}
  async sendPresence(chatId: string, ms: number) { this.presences.push({ chatId, ms }); }
  async sendText(chatId: string, text: string) {
    if (this.failNext > 0) { this.failNext--; throw new Error("mock gateway down"); }
    this.sent.push({ chatId, text, at: this.now() }); return { id: `mock-${this.sent.length}` };
  }
}
