import type { CatalogItem, Conversation, InboundMessage, Order, OrderEvent, OutboundMessage } from "./types";

export class VersionConflictError extends Error {
  constructor(public orderId: string, public expected: number) { super(`Order ${orderId} changed (expected v${expected})`); }
}

export interface StoreTx {
  /** returns false if this WhatsApp message id was already processed (dedupe). */
  claimMessage(msg: InboundMessage): Promise<boolean>;
  getConversation(chatId: string): Promise<Conversation | null>;
  saveConversation(c: Conversation): Promise<void>;
  getOrder(id: string): Promise<Order | null>;
  insertOrder(o: Order): Promise<void>;
  /** optimistic concurrency: must throw VersionConflictError if stored version != expectedVersion */
  updateOrder(o: Order, expectedVersion: number): Promise<void>;
  appendEvent(e: OrderEvent): Promise<void>; // transactional outbox
  enqueueOutbound(m: OutboundMessage): Promise<void>;
  nextOrderNumber(): Promise<string>;
}

export interface OrderStore { withChat<T>(chatId: string, fn: (tx: StoreTx) => Promise<T>): Promise<T> }
export interface CatalogProvider { list(branchId: string): Promise<CatalogItem[]> }

/** In-memory store used by tests and the simulator. Serialises per chat like the Postgres store's advisory lock. */
export class MemoryStore implements OrderStore {
  processed = new Set<string>();
  conversations = new Map<string, Conversation>();
  orders = new Map<string, Order>();
  events: OrderEvent[] = [];
  outbound: OutboundMessage[] = [];
  seq = 1000;
  private locks = new Map<string, Promise<unknown>>();

  async withChat<T>(chatId: string, fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(chatId) ?? Promise.resolve();
    const run = prev.then(async () => {
      // stage writes; commit only on success (all-or-nothing like a DB transaction)
      const staged = { processed: new Set(this.processed), conv: new Map(this.conversations), orders: new Map(this.orders),
        events: [...this.events], outbound: [...this.outbound], seq: this.seq };
      const tx: StoreTx = {
        claimMessage: async (m) => { if (staged.processed.has(m.messageId)) return false; staged.processed.add(m.messageId); return true; },
        getConversation: async (id) => structuredClone(staged.conv.get(id) ?? null),
        saveConversation: async (c) => { staged.conv.set(c.chatId, structuredClone(c)); },
        getOrder: async (id) => structuredClone(staged.orders.get(id) ?? null),
        insertOrder: async (o) => { staged.orders.set(o.id, structuredClone(o)); },
        updateOrder: async (o, v) => {
          const cur = staged.orders.get(o.id);
          if (!cur || cur.version !== v) throw new VersionConflictError(o.id, v);
          staged.orders.set(o.id, structuredClone(o));
        },
        appendEvent: async (e) => { staged.events.push(structuredClone(e)); },
        enqueueOutbound: async (m) => { staged.outbound.push(m); },
        nextOrderNumber: async () => `WA-${++staged.seq}`,
      };
      const r = await fn(tx);
      this.processed = staged.processed; this.conversations = staged.conv; this.orders = staged.orders;
      this.events = staged.events; this.outbound = staged.outbound; this.seq = staged.seq;
      return r;
    });
    this.locks.set(chatId, run.catch(() => undefined));
    return run;
  }
}

export class StaticCatalog implements CatalogProvider {
  constructor(public items: CatalogItem[]) {}
  async list() { return structuredClone(this.items); }
}
