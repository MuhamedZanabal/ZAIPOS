import { z } from "zod";
import promptTemplate from "./prompts/order-parser.md?raw";
import type { CatalogItem, CartLine, ConvStep } from "./types";
import { detectLang, parseRules, type Interpretation, type Intent } from "./parser";

const INTENTS = ["greeting","menu","help","order_items","remove_items","clear_cart","checkout","yes","no","cancel","human","status","opt_out","delivery","pickup","pay_cash","pay_benefit","pay_card","received","unknown"] as const;

/** JSON schema sent as response_format (strict structured output). */
export const LLM_JSON_SCHEMA = {
  name: "whatsapp_order_interpretation",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    required: ["intent", "items", "unmatched", "confidence", "lang"],
    properties: {
      intent: { type: "string", enum: INTENTS },
      items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "qty", "modifiers", "note"],
        properties: { id: { type: "string" }, qty: { type: "integer" }, modifiers: { type: "array", items: { type: "string" } }, note: { type: "string" } } } },
      unmatched: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
      lang: { type: "string", enum: ["en", "ar"] },
    },
  },
} as const;

const Out = z.object({
  intent: z.enum(INTENTS),
  items: z.array(z.object({ id: z.string(), qty: z.number().int(), modifiers: z.array(z.string()), note: z.string() })),
  unmatched: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  lang: z.enum(["en", "ar"]),
});

export interface LlmConfig { baseUrl: string; apiKey: string; model: string; timeoutMs?: number; minConfidence?: number }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function llmConfigFromEnv(env: Record<string, string | undefined>): LlmConfig | null {
  if (!env.WA_LLM_BASE_URL || !env.WA_LLM_API_KEY) return null;
  return { baseUrl: env.WA_LLM_BASE_URL.replace(/\/$/, ""), apiKey: env.WA_LLM_API_KEY, model: env.WA_LLM_MODEL ?? "gpt-4o-mini",
    timeoutMs: Number(env.WA_LLM_TIMEOUT_MS ?? 8000), minConfidence: Number(env.WA_LLM_MIN_CONFIDENCE ?? 0.6) };
}

export function buildPrompt(catalog: CatalogItem[], step: ConvStep, cart: CartLine[]): string {
  const cat = catalog.filter((c) => c.available).map((c) => ({ id: c.productId, name: c.nameEn, name_ar: c.nameAr, category: c.category,
    aliases: c.aliases, modifiers: (c.modifiers ?? []).map((m) => m.name) }));
  return promptTemplate.replace("{{STEP}}", step).replace("{{CART}}", JSON.stringify(cart.map((l) => ({ id: l.productId, qty: l.qty }))))
    .replace("{{CATALOG}}", JSON.stringify(cat));
}

/**
 * Ask the LLM, then validate everything against the real catalog. Any failure
 * (network, timeout, bad JSON, unknown id, low confidence) falls back to rules.
 */
export async function interpret(text: string, catalog: CatalogItem[], step: ConvStep, cart: CartLine[],
  cfg: LlmConfig | null, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<Interpretation & { fallbackReason?: string }> {
  const rules = parseRules(text, catalog);
  // Deterministic commands never need the model.
  if (!cfg || rules.intent === "select_number" || (rules.source === "rules" && rules.confidence >= 0.95 && rules.intent !== "unknown")) {
    return cfg ? rules : { ...rules, fallbackReason: "llm_not_configured" };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 8000);
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, temperature: 0, response_format: { type: "json_schema", json_schema: LLM_JSON_SCHEMA },
        messages: [{ role: "system", content: buildPrompt(catalog, step, cart) }, { role: "user", content: text }] }),
    }).finally(() => clearTimeout(t));
    if (!res.ok) return { ...rules, fallbackReason: `llm_http_${res.status}` };
    const body = await res.json();
    let raw: unknown;
    try { raw = JSON.parse(body?.choices?.[0]?.message?.content ?? "null"); } catch { return { ...rules, fallbackReason: "llm_invalid_json" }; }
    const parsed = Out.safeParse(raw);
    if (!parsed.success) return { ...rules, fallbackReason: "llm_invalid_json" };
    const o = parsed.data;
    if (o.confidence < (cfg.minConfidence ?? 0.6)) return { ...rules, fallbackReason: "llm_low_confidence" };
    const byId = new Map(catalog.map((c) => [c.productId, c]));
    const items = [];
    for (const it of o.items) {
      const c = byId.get(it.id);
      if (!c) return { ...rules, fallbackReason: "llm_unknown_product" }; // hallucination guard
      const allowed = new Set((c.modifiers ?? []).map((m) => m.name));
      items.push({ productId: c.productId, qty: Math.min(Math.max(it.qty, 1), 50), modifiers: it.modifiers.filter((m) => allowed.has(m)) });
    }
    return { intent: o.intent as Intent, items, lang: detectLang(text), confidence: o.confidence, source: "llm" };
  } catch (e) {
    return { ...rules, fallbackReason: (e as Error)?.name === "AbortError" ? "llm_timeout" : "llm_unreachable" };
  }
}
