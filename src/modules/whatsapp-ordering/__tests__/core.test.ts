import { describe, expect, it, vi } from "vitest";
import { TRANSITIONS, assertTransition, canTransition } from "../core/stateMachine";
import { bhdToFils, formatBhd, quote } from "../core/pricing";
import { normalize, parseRules } from "../core/parser";
import { interpret } from "../core/llm";
import { SAMPLE_CATALOG as C } from "../core/fixtures";
import { MemoryOutboxRepo, OutboxDispatcher, PermanentSyncError, backoffMs, type OrderSyncAdapter } from "../core/outbox";
import { WebhookAdapter, signBody } from "../core/adapters/webhook";
import { SheetsCsvAdapter } from "../core/adapters/sheetsCsv";
import { ZaiposPosAdapter } from "../core/adapters/zaiposPos";
import { ThrottledSender, MockGateway } from "../core/sender";
import { parseEvolutionWebhook } from "../core/evolution";
import type { OrderEvent } from "../core/types";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

describe("state machine", () => {
  it("allows the happy paths and blocks skips", () => {
    expect(canTransition("CONFIRMED", "ACCEPTED", "staff")).toBe(true);
    expect(canTransition("CONFIRMED", "DELIVERED", "staff")).toBe(false);
    expect(canTransition("DELIVERED", "CANCELLED", "staff")).toBe(false);
  });
  it("customer may cancel only before preparing", () => {
    expect(canTransition("ACCEPTED", "CANCELLED", "customer")).toBe(true);
    expect(canTransition("PREPARING", "CANCELLED", "customer")).toBe(false);
    expect(canTransition("PREPARING", "CANCELLED", "staff")).toBe(true);
    expect(canTransition("CONFIRMED", "ACCEPTED", "customer")).toBe(false);
  });
  it("delivery vs pickup branches are enforced", () => {
    expect(() => assertTransition("READY", "OUT_FOR_DELIVERY", "staff", "pickup")).toThrow();
    expect(() => assertTransition("READY", "READY_FOR_PICKUP", "staff", "pickup")).not.toThrow();
  });
  it("SQL transition table mirrors the TypeScript one", () => {
    const dir = path.resolve(__dirname, "../../../../supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("whatsapp_ai_ordering.sql"))!;
    const sql = readFileSync(path.join(dir, file), "utf8");
    const block = sql.slice(sql.indexOf("INSERT INTO public.wa_order_transitions"), sql.indexOf("CREATE SEQUENCE"));
    const pairs = [...block.matchAll(/\('([A-Z_]+)','([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const ts = Object.entries(TRANSITIONS).flatMap(([f, tos]) => tos.map((t) => `${f}>${t}`)).sort();
    expect(pairs).toEqual(ts);
  });
});

describe("pricing", () => {
  it("handles fils exactly and VAT 10%", () => {
    expect(bhdToFils("1.250")).toBe(1250);
    expect(formatBhd(5830)).toBe("BHD 5.830");
    const q = quote([{ productId: "a", qty: 3, modifiers: [], unitPriceFils: 333, taxRatePct: 10, nameEn: "a" }], 500);
    expect(q.subtotalFils).toBe(999);
    expect(q.vatFils).toBe(100 + 50); // 99.9 → 100, delivery 50
    expect(q.totalFils).toBe(999 + 500 + 150);
  });
});

describe("rule parser (LLM fallback)", () => {
  it("parses English quantities and modifiers", () => {
    const r = parseRules("2 chicken shawarma no onion and a karak", C);
    expect(r.intent).toBe("order_items");
    expect(r.items).toEqual([{ productId: "p-shawarma", qty: 2, modifiers: ["no onion"] }, { productId: "p-karak", qty: 1, modifiers: [] }]);
  });
  it("parses Gulf Arabic with Arabic digits and dual", () => {
    const r = parseRules("ابي حبتين شاورما بدون بصل و ٣ كرك", C);
    expect(r.items).toEqual([{ productId: "p-shawarma", qty: 2, modifiers: ["no onion"] }, { productId: "p-karak", qty: 3, modifiers: [] }]);
    expect(r.lang).toBe("ar");
  });
  it("keywords", () => {
    expect(parseRules("وين طلبي", C).intent).toBe("status");
    expect(parseRules("ابي اكلم موظف", C).intent).toBe("human");
    expect(parseRules("STOP", C).intent).toBe("opt_out");
    expect(parseRules("تمام", C).intent).toBe("yes");
    expect(parseRules("3", C)).toMatchObject({ intent: "select_number", number: 3 });
    expect(normalize("أهلاً")).toBe("اهلا");
  });
});

describe("LLM interpreter", () => {
  const cfg = { baseUrl: "http://llm", apiKey: "k", model: "m", timeoutMs: 50 };
  const reply = (content: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) }));
  it("accepts valid structured output limited to the catalog", async () => {
    const f = reply({ intent: "order_items", items: [{ id: "p-machboos", qty: 1, modifiers: ["made-up"], note: "" }], unmatched: [], confidence: 0.9, lang: "ar" });
    const r = await interpret("عطني صحن مجبوس لو سمحت", C, "building", [], cfg, f);
    expect(r).toMatchObject({ source: "llm", items: [{ productId: "p-machboos", qty: 1, modifiers: [] }] });
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0].content).toContain("p-machboos");
  });
  it("rejects hallucinated products and falls back to rules", async () => {
    const f = reply({ intent: "order_items", items: [{ id: "p-pizza", qty: 1, modifiers: [], note: "" }], unmatched: [], confidence: 0.99, lang: "en" });
    const r = await interpret("one pizza and a karak please", C, "building", [], cfg, f);
    expect(r.fallbackReason).toBe("llm_unknown_product");
    expect(r.items).toEqual([{ productId: "p-karak", qty: 1, modifiers: [] }]);
  });
  it("falls back when the LLM is down or unsure", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect((await interpret("i want falafel pls", C, "building", [], cfg, down as any)).fallbackReason).toBe("llm_unreachable");
    const unsure = reply({ intent: "order_items", items: [], unmatched: [], confidence: 0.2, lang: "en" });
    expect((await interpret("hmm maybe something", C, "building", [], cfg, unsure)).fallbackReason).toBe("llm_low_confidence");
    const bad = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{not json" } }] }) }));
    expect((await interpret("something tasty", C, "building", [], cfg, bad)).fallbackReason).toBe("llm_invalid_json");
  });
});

const ev = (n: number, orderId = "o1"): OrderEvent => ({ id: `e${n}`, orderId, type: "order.status_changed", from: "CONFIRMED", to: "ACCEPTED", version: n, actor: "staff",
  at: `2026-10-12T10:00:0${n}Z`, key: `${orderId}:${n}`, order: { id: orderId, orderNumber: "WA-1001", chatId: "97333334444@s.whatsapp.net", branchId: "b", status: "ACCEPTED",
  version: n, lines: [{ productId: "p", qty: 2, modifiers: [], unitPriceFils: 800, taxRatePct: 10, nameEn: "Shawarma" }], fulfilment: "delivery", address: "Seef",
  location: null, paymentMethod: "cash_on_delivery", deliveryFeeFils: 500, quotedTotalFils: 2310, etaMinutes: 30, courierName: null, cancelReason: null, createdAt: "", updatedAt: "" } });

describe("outbox dispatcher", () => {
  it("retries with backoff, keeps per-order order, dead-letters, and admin requeue works", async () => {
    let now = 0; let fails = 2; const seen: string[] = [];
    const flaky: OrderSyncAdapter = { name: "flaky", health: async () => ({ ok: true }), onEvent: async (e) => { if (fails-- > 0) throw new Error("503"); seen.push(e.key); } };
    const events = [ev(2), ev(3)];
    const repo = new MemoryOutboxRepo(() => events, ["flaky"]);
    const d = new OutboxDispatcher(repo, [flaky], { now: () => now, baseMs: 1000 });
    expect(await d.runOnce()).toEqual({ done: 0, retried: 1, dead: 0 }); // e3 not attempted before e2
    now += 500; expect((await d.runOnce()).retried).toBe(0); // backoff not elapsed
    now += 5000; await d.runOnce(); now += 10000; await d.runOnce();
    expect(seen).toEqual(["o1:2", "o1:3"]);
    const dead: OrderSyncAdapter = { name: "dead", health: async () => ({ ok: false }), onEvent: async () => { throw new PermanentSyncError("400"); } };
    const repo2 = new MemoryOutboxRepo(() => [ev(2)], ["dead"]);
    await new OutboxDispatcher(repo2, [dead], { now: () => 0 }).runOnce();
    expect(repo2.dead()).toHaveLength(1);
    repo2.requeue("e2", "dead"); expect(repo2.dead()).toHaveLength(0);
    expect(backoffMs(1, 1000, 60000, () => 0.5)).toBe(1000);
    expect(backoffMs(20, 1000, 60000, () => 0.5)).toBe(60000);
  });
});

describe("adapters", () => {
  it("webhook adapter signs with HMAC, sends idempotency key, classifies errors", async () => {
    const calls: any[] = [];
    const f = vi.fn(async (_u: string, init: any) => { calls.push(init); return { ok: false, status: calls.length === 1 ? 503 : calls.length === 2 ? 409 : 400, json: async () => ({}) }; });
    const a = new WebhookAdapter("erp", "http://erp/hook", "s3cret", f as any, () => 1_000_000);
    await expect(a.onEvent(ev(2))).rejects.toThrow("webhook 503");
    await expect(a.onEvent(ev(2))).resolves.toBeUndefined(); // 409 duplicate = success
    await expect(a.onEvent(ev(2))).rejects.toBeInstanceOf(PermanentSyncError);
    expect(calls[0].headers["Idempotency-Key"]).toBe("o1:2");
    expect(calls[0].headers["X-ZAIPOS-Signature"]).toBe(`v1=${signBody("s3cret", "1000", calls[0].body)}`);
  });
  it("sheets/csv adapter appends once per event and masks phone", async () => {
    const rows: string[] = []; const a = new SheetsCsvAdapter({ readKeys: async () => new Set(rows.map((r) => r.split(",")[0])), append: async (l) => { rows.push(l); } });
    await a.onEvent(ev(2)); await a.onEvent(ev(2));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("WA-1001,ACCEPTED");
    expect(rows[0]).toContain("2.310"); // 1.600 + 0.500 + VAT 0.210
    expect(rows[0]).not.toContain("97333334444");
  });
  it("ZAIPOS adapter passes the event to the sync RPC and marks validation errors permanent", async () => {
    const call = vi.fn(async () => { throw new Error("Product p not found"); });
    await expect(new ZaiposPosAdapter(call).onEvent(ev(2))).rejects.toBeInstanceOf(PermanentSyncError);
    const ok = vi.fn(async () => null); await new ZaiposPosAdapter(ok).onEvent(ev(2));
    expect(ok).toHaveBeenCalledWith("wa_sync_order_to_pos", [expect.stringContaining('"key":"o1:2"')]);
  });
});

describe("throttled sender", () => {
  it("enforces per-chat gap, global cap and typing delay", async () => {
    let now = 0; const gw = new MockGateway(() => now);
    const s = new ThrottledSender(gw, { perChatGapMs: 2000, globalPerMinute: 3, typingMsPerChar: 10, typingMinMs: 500, typingMaxMs: 3000, jitterMs: 0 },
      { now: () => now, sleep: async (ms) => { now += ms; } }, () => 0);
    for (let i = 0; i < 4; i++) await s.send({ id: String(i), chatId: i < 2 ? "a" : `c${i}`, text: "hello", attempts: 0, notBefore: 0 });
    expect(gw.sent[1].at - gw.sent[0].at).toBeGreaterThanOrEqual(2000);
    expect(gw.sent[3].at - gw.sent[0].at).toBeGreaterThanOrEqual(60_000); // 4th message waits for the 1-minute window
    expect(gw.presences[0].ms).toBe(500);
  });
});

describe("evolution webhook parsing", () => {
  it("ignores own, group and status messages", () => {
    const base = { event: "messages.upsert", data: { key: { remoteJid: "97333334444@s.whatsapp.net", id: "X", fromMe: false }, message: { conversation: "hi" } } };
    expect(parseEvolutionWebhook(base)?.text).toBe("hi");
    expect(parseEvolutionWebhook({ ...base, data: { ...base.data, key: { ...base.data.key, fromMe: true } } })).toBeNull();
    expect(parseEvolutionWebhook({ ...base, data: { ...base.data, key: { ...base.data.key, remoteJid: "123@g.us" } } })).toBeNull();
    expect(parseEvolutionWebhook({ ...base, data: { ...base.data, key: { ...base.data.key, remoteJid: "status@broadcast" } } })).toBeNull();
    expect(parseEvolutionWebhook({ ...base, event: "messages.update" })).toBeNull();
  });
});
