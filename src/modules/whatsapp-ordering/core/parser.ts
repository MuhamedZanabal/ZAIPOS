import type { CatalogItem, Lang } from "./types";

export type Intent =
  | "greeting" | "menu" | "help" | "order_items" | "remove_items" | "clear_cart" | "checkout"
  | "yes" | "no" | "cancel" | "human" | "status" | "opt_out" | "opt_in" | "delivery" | "pickup"
  | "pay_cash" | "pay_benefit" | "pay_card" | "select_number" | "received" | "unknown";

export interface ParsedItem { productId: string; qty: number; modifiers: string[] }
export interface Interpretation {
  intent: Intent;
  items: ParsedItem[];
  number?: number;
  lang: Lang;
  confidence: number;
  source: "rules" | "llm";
}

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export function normalize(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[إأآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ًٌٍَُِّْـ]/g, "")
    .toLowerCase().replace(/[!?.,،؟]+/g, " ").replace(/\s+/g, " ").trim();
}
export const detectLang = (text: string): Lang => (/[\u0600-\u06FF]/.test(text) ? "ar" : "en");

const NUM_WORDS: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  "واحد": 1, "وحده": 1, "حبه": 1, "اثنين": 2, "ثنين": 2, "ثنتين": 2, "اثنتين": 2, "حبتين": 2,
  "ثلاث": 3, "ثلاثه": 3, "اربع": 4, "اربعه": 4, "خمس": 5, "خمسه": 5, "ست": 6, "سته": 6,
  "سبع": 7, "ثمان": 8, "تسع": 9, "عشر": 10,
};

// keyword lists (normalized). Order matters: first match wins.
const KW: [Intent, RegExp][] = [
  ["opt_out", /^(stop|unsubscribe|ايقاف|وقف|لا ترسل)$/],
  ["opt_in", /^(start|ابدا)$/],
  ["human", /\b(human|agent|staff|person|someone|talk to)\b|موظف|انسان|احد يكلمني|خدمه العملاء|ابي اكلم/],
  ["cancel", /\b(cancel|cancel order)\b|الغ|كنسل|ما ابي الطلب/],
  ["help", /^(help|\?|h)$|مساعد|ساعدني/],
  ["status", /\b(status|where is my order|track|eta)\b|وين طلبي|حاله الطلب|متي يوصل|كم باقي/],
  ["received", /\b(received|got it|delivered)\b|استلمت|وصلني|وصل الطلب/],
  ["clear_cart", /\b(clear|empty)( cart| basket)?\b|امسح السله|فضي/],
  ["menu", /\b(menu|categories|list)\b|منيو|القائمه|المنيو|شعندكم|وش عندكم/],
  ["delivery", /\b(delivery|deliver)\b|توصيل|وصلوه|ديلفري/],
  ["pickup", /\b(pick ?up|collect|takeaway|take away)\b|استلام|بجي اخذ|باخذه|تيك اوي/],
  ["pay_benefit", /\bbenefit(pay)?\b|بنفت|بنفيت/],
  ["pay_card", /\b(card|visa|mada)\b|بطاقه|كارت|فيزا/],
  ["pay_cash", /\b(cash|cod)\b|كاش|نقد/],
  ["checkout", /\b(done|checkout|that'?s all|finish|nothing else)\b|خلاص بس|بس كذا|خلصت|هذا كل|لا شي ثاني/],
  ["yes", /^(yes|y|ok|okay|confirm|sure|yep|yeah|تمام|اوكي|ايوه|اي|نعم|اكيد|اكد|موافق|ok confirm)$/],
  ["no", /^(no|n|nope|change|edit|لا|تعديل|غير)$/],
  ["greeting", /^(hi|hello|hey|salam|salaam|good (morning|evening))\b|^(السلام|سلام|مرحبا|هلا|هلو|صباح|مساء)/],
];

const REMOVE_RX = /\b(remove|delete|without the|no more)\b|شيل|احذف|بدون ال/;

function matchItems(norm: string, catalog: CatalogItem[]): ParsedItem[] {
  const found: { item: CatalogItem; idx: number; len: number }[] = [];
  for (const item of catalog) {
    const names = [item.nameEn, item.nameAr ?? "", ...(item.aliases ?? [])].filter(Boolean).map(normalize);
    for (const n of names.sort((a, b) => b.length - a.length)) {
      const idx = norm.indexOf(n);
      if (idx >= 0) { found.push({ item, idx, len: n.length }); break; }
    }
  }
  // drop matches contained inside longer matches (e.g. "tea" in "karak tea")
  const kept = found.filter((f) => !found.some((g) => g !== f && g.len > f.len && g.idx <= f.idx && g.idx + g.len >= f.idx + f.len));
  kept.sort((a, b) => a.idx - b.idx);
  return kept.map((f, i) => {
    const start = i === 0 ? 0 : kept[i - 1].idx + kept[i - 1].len;
    const before = norm.slice(start, f.idx).trim().split(" ");
    const after = norm.slice(f.idx + f.len).trim().split(" ");
    let qty = 1;
    const tok = before[before.length - 1] ?? "";
    const tokAfter = after[0] ?? "";
    if (/^\d{1,2}$/.test(tok)) qty = Number(tok);
    else if (NUM_WORDS[tok]) qty = NUM_WORDS[tok];
    else if (/^x?\d{1,2}$/.test(tokAfter.replace("×", "x"))) qty = Number(tokAfter.replace(/[x×]/, ""));
    const segEnd = i + 1 < kept.length ? kept[i + 1].idx : norm.length;
    const seg = norm.slice(f.idx, segEnd);
    const modifiers = (f.item.modifiers ?? [])
      .filter((m) => [m.name, m.nameAr ?? ""].filter(Boolean).some((n) => seg.includes(normalize(n))))
      .map((m) => m.name);
    return { productId: f.item.productId, qty: Math.min(Math.max(qty, 1), 50), modifiers };
  });
}

/** Deterministic interpreter: works with no LLM at all. */
export function parseRules(text: string, catalog: CatalogItem[]): Interpretation {
  const lang = detectLang(text);
  const norm = normalize(text);
  if (/^\d{1,2}$/.test(norm)) return { intent: "select_number", number: Number(norm), items: [], lang, confidence: 1, source: "rules" };
  const items = matchItems(norm, catalog);
  if (items.length) {
    return { intent: REMOVE_RX.test(norm) ? "remove_items" : "order_items", items, lang, confidence: 0.9, source: "rules" };
  }
  for (const [intent, rx] of KW) if (rx.test(norm)) return { intent, items: [], lang, confidence: 0.95, source: "rules" };
  return { intent: "unknown", items: [], lang, confidence: 0, source: "rules" };
}
