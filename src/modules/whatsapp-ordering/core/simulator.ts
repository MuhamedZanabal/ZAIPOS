import { OrderEngine, type EngineConfig } from "./engine";
import { MemoryStore, StaticCatalog } from "./store";
import { MemoryOutboxRepo, OutboxDispatcher, type OrderSyncAdapter } from "./outbox";
import { CustomerNotifierAdapter } from "./adapters/customerNotifier";
import { parseEvolutionWebhook } from "./evolution";
import { MockGateway, ThrottledSender, DEFAULT_THROTTLE } from "./sender";
import type { CatalogItem, OrderStatus } from "./types";

/**
 * End-to-end simulator: mock Evolution webhooks in → engine → outbox → adapters →
 * throttled sender → MockGateway. No real WhatsApp traffic is possible from here.
 */
export class Simulation {
  store = new MemoryStore();
  catalog: StaticCatalog;
  engine: OrderEngine;
  gateway: MockGateway;
  sender: ThrottledSender;
  outbox: OutboxDispatcher;
  repo: MemoryOutboxRepo;
  transcript: string[] = [];
  clock = 1_760_000_000_000;
  private msgSeq = 0;
  private sentCursor = 0;
  private notified = new Set<string>();

  constructor(items: CatalogItem[], extraAdapters: OrderSyncAdapter[] = [], cfg: Partial<EngineConfig> = {}) {
    this.catalog = new StaticCatalog(structuredClone(items));
    let idSeq = 0;
    this.engine = new OrderEngine(this.store, this.catalog, { shopName: "Seef Grill", branchId: "b1", deliveryFeeFils: 500, defaultEtaMinutes: 35,
      ordersOpen: () => true, llm: null, now: () => new Date(this.clock), newId: () => `id-${++idSeq}`, ...cfg });
    const notifier = new CustomerNotifierAdapter({
      langOf: async (c) => this.store.conversations.get(c)?.lang ?? "en",
      optedOut: async (c) => this.store.conversations.get(c)?.optedOut ?? false,
      enqueue: async (chatId, text, key) => { if (this.notified.has(key)) return; this.notified.add(key); this.store.outbound.push({ chatId, text }); },
    });
    const adapters = [notifier, ...extraAdapters];
    this.repo = new MemoryOutboxRepo(() => this.store.events, adapters.map((a) => a.name));
    this.outbox = new OutboxDispatcher(this.repo, adapters, { baseMs: 1000, now: () => this.clock });
    this.gateway = new MockGateway(() => this.clock);
    this.sender = new ThrottledSender(this.gateway, DEFAULT_THROTTLE, { now: () => this.clock, sleep: async (ms) => { this.clock += ms; } }, () => 0.5);
  }

  webhook(chatId: string, text: string, opts: { id?: string; location?: { lat: number; lng: number; address?: string } } = {}) {
    const id = opts.id ?? `WAMID-${++this.msgSeq}`;
    return { event: "messages.upsert", instance: "seefgrill", data: { key: { remoteJid: chatId, fromMe: false, id }, pushName: "Customer",
      message: opts.location ? { locationMessage: { degreesLatitude: opts.location.lat, degreesLongitude: opts.location.lng, address: opts.location.address } } : { conversation: text },
      messageTimestamp: Math.floor(this.clock / 1000) } };
  }

  /** Customer sends a message; returns the bot replies that went out through the gateway. */
  async say(chatId: string, text: string, opts: { id?: string; location?: { lat: number; lng: number; address?: string } } = {}) {
    const msg = parseEvolutionWebhook(this.webhook(chatId, text, opts));
    this.transcript.push(`👤 ${opts.location ? `[📍 ${opts.location.address ?? `${opts.location.lat},${opts.location.lng}`}]` : text}`);
    const r = msg ? await this.engine.handle(msg) : { status: "ignored" as const };
    if (r.status !== "processed") this.transcript.push(`   (${r.status})`);
    return this.flush();
  }

  async staff(chatId: string, to: OrderStatus, patch = {}) {
    const conv = this.store.conversations.get(chatId)!;
    const id = conv.activeOrderId ?? [...this.store.orders.values()].filter((o) => o.chatId === chatId).at(-1)!.id;
    const o = this.store.orders.get(id)!;
    this.transcript.push(`🧑‍🍳 [staff: ${o.status} → ${to}]`);
    await this.engine.staffTransition(chatId, id, to, o.version, patch);
    return this.flush();
  }

  async flush() {
    this.clock += 10;
    await this.outbox.runOnce();
    const out: string[] = [];
    while (this.sentCursor < this.store.outbound.length) {
      const m = this.store.outbound[this.sentCursor++];
      await this.sender.send({ id: String(this.sentCursor), chatId: m.chatId, text: m.text, attempts: 0, notBefore: 0 });
      out.push(m.text); this.transcript.push(`🤖 ${m.text.replace(/\n/g, "\n   ")}`);
    }
    return out;
  }

  order(chatId: string) {
    return [...this.store.orders.values()].filter((o) => o.chatId === chatId).at(-1)!;
  }
}
