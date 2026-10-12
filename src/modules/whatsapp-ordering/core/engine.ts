import type { Actor, CartLine, CatalogItem, Conversation, InboundMessage, Lang, Order, OrderStatus } from "./types";
import { VersionConflictError, type CatalogProvider, type OrderStore, type StoreTx } from "./store";
import { assertTransition, CUSTOMER_CANCELLABLE, isTerminal } from "./stateMachine";
import { interpret, type FetchLike, type LlmConfig } from "./llm";
import type { Interpretation } from "./parser";
import { formatBhd, quote } from "./pricing";
import { M } from "./messages";

export interface EngineConfig {
  shopName: string;
  branchId: string;
  deliveryFeeFils: number;
  defaultEtaMinutes: number;
  ordersOpen: () => boolean;
  llm: LlmConfig | null;
  fetchImpl?: FetchLike;
  now?: () => Date;
  newId?: () => string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type HandleResult = { status: "processed" | "duplicate" | "ignored"; fallbackReason?: string };

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

/**
 * Applies a status change. The only code path that mutates order.status in TS;
 * the SQL function wa_transition_order is the equivalent for staff/POS.
 */
export async function transition(tx: StoreTx, order: Order, to: OrderStatus, actor: Actor, now: Date,
  patch: Partial<Order> = {}, newId: () => string = uid): Promise<Order> {
  assertTransition(order.status, to, actor, patch.fulfilment ?? order.fulfilment);
  const next: Order = { ...order, ...patch, status: to, version: order.version + 1, updatedAt: now.toISOString() };
  await tx.updateOrder(next, order.version);
  // Draft-internal moves are not business events; everything from CONFIRMED on goes to the outbox.
  if (!(["DRAFT", "AWAITING_CONFIRMATION"] as OrderStatus[]).includes(to) && !(to === "CANCELLED" && order.orderNumber === null)) {
    await tx.appendEvent({ id: newId(), orderId: next.id, type: "order.status_changed", from: order.status, to, version: next.version,
      actor, at: next.updatedAt, order: next, key: `${next.id}:${next.version}` });
  }
  return next;
}

export class OrderEngine {
  constructor(private store: OrderStore, private catalog: CatalogProvider, private cfg: EngineConfig) {}
  private now() { return this.cfg.now?.() ?? new Date(); }
  private id() { return this.cfg.newId?.() ?? uid(); }

  async handle(msg: InboundMessage): Promise<HandleResult> {
    return this.store.withChat(msg.chatId, async (tx) => {
      if (!(await tx.claimMessage(msg))) return { status: "duplicate" as const };
      const now = this.now();
      let conv = (await tx.getConversation(msg.chatId)) ?? {
        chatId: msg.chatId, lang: "en" as Lang, step: "idle" as const, activeOrderId: null, handoff: false, optedOut: false,
        lastMenu: null, handoffReason: null, updatedAt: now.toISOString(),
      };
      const catalog = await this.catalog.list(this.cfg.branchId);
      let order = conv.activeOrderId ? await tx.getOrder(conv.activeOrderId) : null;
      if (order && isTerminal(order.status)) { order = null; conv.activeOrderId = null; conv.step = "idle"; }
      const cart = order?.lines ?? [];
      const it = await interpret(msg.text || (msg.location ? "location" : ""), catalog, conv.step, cart, this.cfg.llm, this.cfg.fetchImpl);
      if (it.fallbackReason && it.fallbackReason !== "llm_not_configured") this.cfg.log?.("llm_fallback", { reason: it.fallbackReason, chat: msg.chatId });
      if (msg.text.trim()) conv.lang = it.lang;
      const lang = conv.lang;
      const say = (text: string) => tx.enqueueOutbound({ chatId: msg.chatId, text });

      // Opt-out is honoured before anything else; opted-out chats get no messages.
      if (conv.optedOut) {
        if (it.intent === "opt_in") { conv.optedOut = false; await say(M.greeting(lang, this.cfg.shopName)); }
        return this.done(tx, conv, now, it);
      }
      if (it.intent === "opt_out") { conv.optedOut = true; await say(M.optedOut(lang)); return this.done(tx, conv, now, it); }
      // Staff has taken over this chat: AI stays silent (the message is still stored for the staff inbox).
      if (conv.handoff) return this.done(tx, conv, now, it);
      if (it.intent === "human") {
        conv.handoff = true; conv.handoffReason = "customer_request"; await say(M.handoff(lang)); return this.done(tx, conv, now, it);
      }
      if (it.intent === "help") { await say(M.help(lang)); return this.done(tx, conv, now, it); }

      // ---- An order is placed and in progress: tracking mode (one active order per chat) ----
      if (order && !["DRAFT", "AWAITING_CONFIRMATION"].includes(order.status)) {
        if (it.intent === "cancel") {
          if (CUSTOMER_CANCELLABLE.includes(order.status)) {
            await transition(tx, order, "CANCELLED", "customer", now, { cancelReason: lang === "ar" ? "بطلب العميل" : "requested by customer" }, () => this.id());
            conv.activeOrderId = null; conv.step = "idle";
          } else if (["PREPARING", "READY", "READY_FOR_PICKUP"].includes(order.status)) {
            conv.handoff = true; conv.handoffReason = `cancel_request:${order.orderNumber}`; await say(M.cancelRequested(lang));
          } else await say(M.cannotCancel(lang));
        } else if (it.intent === "received" && order.status === "OUT_FOR_DELIVERY") {
          await transition(tx, order, "DELIVERED", "system", now, {}, () => this.id());
          conv.activeOrderId = null; conv.step = "idle";
        } else if (it.intent === "order_items" || it.intent === "menu") {
          await say(M.activeOrder(lang, order));
        } else {
          await say(M.status(lang, order));
        }
        return this.done(tx, conv, now, it);
      }

      if (!this.cfg.ordersOpen()) { await say(M.closed(lang)); return this.done(tx, conv, now, it); }

      // ---- Draft flow ----
      if (it.intent === "cancel") {
        if (order) await transition(tx, order, "CANCELLED", "customer", now, {}, () => this.id());
        conv.activeOrderId = null; conv.step = "idle"; conv.lastMenu = null;
        await say(M.cancelledDraft(lang)); return this.done(tx, conv, now, it);
      }
      const ensureOrder = async () => {
        if (order) return order;
        order = { id: this.id(), orderNumber: null, chatId: msg.chatId, branchId: this.cfg.branchId, status: "DRAFT", version: 1, lines: [],
          fulfilment: null, address: null, location: null, paymentMethod: null, deliveryFeeFils: 0, quotedTotalFils: null,
          etaMinutes: null, courierName: null, cancelReason: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
        await tx.insertOrder(order); conv.activeOrderId = order.id; return order;
      };
      const saveDraft = async (patch: Partial<Order>) => {
        const o = await ensureOrder();
        const next = { ...o, ...patch, version: o.version + 1, updatedAt: now.toISOString() };
        await tx.updateOrder(next, o.version); order = next; return next;
      };
      const addItems = async (items: Interpretation["items"], remove = false) => {
        const byId = new Map(catalog.map((c) => [c.productId, c]));
        const sold: string[] = [];
        const lines = [...(order?.lines ?? [])];
        for (const p of items) {
          const c = byId.get(p.productId)!;
          if (remove) { const i = lines.findIndex((l) => l.productId === p.productId); if (i >= 0) lines.splice(i, 1); continue; }
          if (!c.available || (c.stock != null && c.stock < p.qty)) { sold.push(lang === "ar" && c.nameAr ? c.nameAr : c.nameEn); continue; }
          const modPrice = (c.modifiers ?? []).filter((m) => p.modifiers.includes(m.name)).reduce((a, m) => a + m.priceFils, 0);
          const same = lines.find((l) => l.productId === p.productId && l.modifiers.join() === [...p.modifiers].sort().join());
          if (same) same.qty += p.qty;
          else lines.push({ productId: c.productId, qty: p.qty, modifiers: [...p.modifiers].sort(), unitPriceFils: c.priceFils + modPrice,
            taxRatePct: c.taxRatePct, nameEn: c.nameEn, nameAr: c.nameAr });
        }
        if (sold.length) await say(M.soldOut(lang, sold));
        await saveDraft({ lines }); conv.step = "building";
        await say(M.cart(lang, lines));
      };
      const categories = () => {
        const seen = new Map<string, { en: string; ar?: string }>();
        for (const c of catalog) if (!seen.has(c.category)) seen.set(c.category, { en: c.category, ar: c.categoryAr });
        return [...seen.entries()];
      };
      const showMenu = async () => {
        const cats = categories();
        conv.lastMenu = { kind: "categories", ids: cats.map(([k]) => k) };
        await say(M.categories(lang, cats.map(([, v]) => v)));
      };
      const reask = async () => {
        if (conv.step === "fulfilment") return say(M.askFulfilment(lang, this.cfg.deliveryFeeFils));
        if (conv.step === "address") return say(M.askAddress(lang));
        if (conv.step === "payment") return say(M.askPayment(lang));
        if (conv.step === "confirm" && order) return say(M.summary(lang, order));
        return say(M.didntUnderstand(lang, lang === "ar" ? "اكتب *منيو* أو *مساعدة*." : "Reply *menu* or *help*."));
      };

      // Step-specific answers first (numbers mean different things per step).
      if (conv.step === "fulfilment") {
        const choice = it.intent === "delivery" || it.number === 1 ? "delivery" : it.intent === "pickup" || it.number === 2 ? "pickup" : null;
        if (choice) {
          await saveDraft({ fulfilment: choice, deliveryFeeFils: choice === "delivery" ? this.cfg.deliveryFeeFils : 0 });
          conv.step = choice === "delivery" ? "address" : "payment";
          await say(choice === "delivery" ? M.askAddress(lang) : M.askPayment(lang));
          return this.done(tx, conv, now, it);
        }
      } else if (conv.step === "address") {
        const text = msg.text.trim();
        if (msg.location || (text.length >= 5 && it.intent !== "order_items" && it.intent !== "menu")) {
          await saveDraft({ address: msg.location?.address ?? (text || null), location: msg.location ? { lat: msg.location.lat, lng: msg.location.lng } : null });
          conv.step = "payment"; await say(M.askPayment(lang)); return this.done(tx, conv, now, it);
        }
      } else if (conv.step === "payment") {
        const pm = it.intent === "pay_cash" || it.number === 1 ? "cash_on_delivery" : it.intent === "pay_benefit" || it.number === 2 ? "benefitpay"
          : it.intent === "pay_card" || it.number === 3 ? "card_on_delivery" : null;
        if (pm) {
          const o = await saveDraft({ paymentMethod: pm });
          const q = quote(o.lines, o.deliveryFeeFils);
          order = await transition(tx, o, "AWAITING_CONFIRMATION", "customer", now, { quotedTotalFils: q.totalFils }, () => this.id());
          conv.step = "confirm"; await say(M.summary(lang, order)); return this.done(tx, conv, now, it);
        }
      } else if (conv.step === "confirm" && order) {
        if (it.intent === "yes") { await this.confirm(tx, conv, order, catalog, lang, now); return this.done(tx, conv, now, it); }
        if (it.intent === "no" || it.intent === "order_items" || it.intent === "remove_items") {
          order = await transition(tx, order, "DRAFT", "customer", now, {}, () => this.id());
          conv.step = "building";
          if (it.intent === "no") { await say(M.cart(lang, order.lines)); return this.done(tx, conv, now, it); }
        }
      }

      switch (it.intent) {
        case "greeting": await say(M.greeting(lang, this.cfg.shopName)); if (order?.lines.length) await say(M.cart(lang, order.lines)); break;
        case "menu": await showMenu(); break;
        case "order_items": await addItems(it.items); break;
        case "remove_items": await addItems(it.items, true); break;
        case "clear_cart": await saveDraft({ lines: [] }); await say(M.cart(lang, [])); break;
        case "select_number": {
          const menu = conv.lastMenu; const n = it.number!;
          if (menu?.kind === "categories" && menu.ids[n - 1]) {
            const items = catalog.filter((c) => c.category === menu.ids[n - 1]);
            conv.lastMenu = { kind: "items", ids: items.map((c) => c.productId) };
            await say(M.items(lang, items));
          } else if (menu?.kind === "items" && menu.ids[n - 1]) {
            await addItems([{ productId: menu.ids[n - 1], qty: 1, modifiers: [] }]);
          } else await reask();
          break;
        }
        case "checkout":
          if (!order?.lines.length) { await say(M.cart(lang, [])); break; }
          conv.step = "fulfilment"; await say(M.askFulfilment(lang, this.cfg.deliveryFeeFils)); break;
        case "status": await say(M.noOrder(lang)); break;
        case "unknown":
          if (conv.step === "idle" && !order) await say(M.greeting(lang, this.cfg.shopName));
          else if (conv.step === "building") await say(M.notFound(lang, msg.text.slice(0, 40)));
          else await reask();
          break;
        default: await reask();
      }
      return this.done(tx, conv, now, it);
    });
  }

  /** Staff / POS side (the SQL function wa_transition_order is the production twin). Last writer loses on stale version. */
  async staffTransition(chatId: string, orderId: string, to: OrderStatus, expectedVersion: number, patch: Partial<Order> = {}, actor: Actor = "staff") {
    return this.store.withChat(chatId, async (tx) => {
      const o = await tx.getOrder(orderId);
      if (!o) throw new Error("order not found");
      if (o.version !== expectedVersion) throw new VersionConflictError(orderId, expectedVersion);
      const next = await transition(tx, o, to, actor, this.now(), patch, () => this.id());
      if (isTerminal(to)) {
        const c = await tx.getConversation(chatId);
        if (c && c.activeOrderId === orderId) { c.activeOrderId = null; c.step = "idle"; await tx.saveConversation(c); }
      }
      return next;
    });
  }

  async setHandoff(chatId: string, on: boolean) {
    return this.store.withChat(chatId, async (tx) => {
      const c = await tx.getConversation(chatId);
      if (!c) return;
      c.handoff = on; c.handoffReason = on ? "staff_takeover" : null; await tx.saveConversation(c);
      if (!on) await tx.enqueueOutbound({ chatId, text: M.resumed(c.lang) });
    });
  }

  /** Re-validate against the live catalog; re-quote on any change, otherwise CONFIRMED. */
  private async confirm(tx: StoreTx, conv: Conversation, order: Order, catalog: CatalogItem[], lang: Lang, now: Date) {
    const byId = new Map(catalog.map((c) => [c.productId, c]));
    const changes: string[] = [];
    const lines: CartLine[] = [];
    for (const l of order.lines) {
      const c = byId.get(l.productId);
      const nm = lang === "ar" && l.nameAr ? l.nameAr : l.nameEn;
      if (!c || !c.available || (c.stock != null && c.stock <= 0)) { changes.push(`• ${nm}: ${lang === "ar" ? "غير متوفر – تم حذفه" : "sold out – removed"}`); continue; }
      let qty = l.qty;
      if (c.stock != null && c.stock < qty) { qty = c.stock; changes.push(`• ${nm}: ${lang === "ar" ? `المتوفر ${qty} فقط` : `only ${qty} left`}`); }
      const modPrice = (c.modifiers ?? []).filter((m) => l.modifiers.includes(m.name)).reduce((a, m) => a + m.priceFils, 0);
      const unit = c.priceFils + modPrice;
      if (unit !== l.unitPriceFils) changes.push(`• ${nm}: ${formatBhd(l.unitPriceFils)} → ${formatBhd(unit)}`);
      lines.push({ ...l, qty, unitPriceFils: unit, taxRatePct: c.taxRatePct });
    }
    if (changes.length) {
      const q = quote(lines, order.deliveryFeeFils);
      const next = { ...order, lines, quotedTotalFils: q.totalFils, version: order.version + 1, updatedAt: now.toISOString() };
      await tx.updateOrder(next, order.version);
      if (!lines.length) {
        await transition(tx, next, "DRAFT", "customer", now, {}, () => this.id());
        conv.step = "building";
        await tx.enqueueOutbound({ chatId: conv.chatId, text: M.requote(lang, changes).split("\n").slice(0, -1).join("\n") });
        await tx.enqueueOutbound({ chatId: conv.chatId, text: M.cart(lang, []) });
        return;
      }
      await tx.enqueueOutbound({ chatId: conv.chatId, text: M.requote(lang, changes) });
      await tx.enqueueOutbound({ chatId: conv.chatId, text: M.summary(lang, next) });
      return; // stays AWAITING_CONFIRMATION; customer must say yes again
    }
    const orderNumber = order.orderNumber ?? (await tx.nextOrderNumber());
    await transition(tx, order, "CONFIRMED", "customer", now, { orderNumber, etaMinutes: this.cfg.defaultEtaMinutes }, () => this.id());
    conv.step = "tracking"; conv.lastMenu = null;
  }

  private async done(tx: StoreTx, conv: Conversation, now: Date, it: Interpretation & { fallbackReason?: string }): Promise<HandleResult> {
    conv.updatedAt = now.toISOString();
    await tx.saveConversation(conv);
    return { status: "processed", fallbackReason: it.fallbackReason };
  }
}
