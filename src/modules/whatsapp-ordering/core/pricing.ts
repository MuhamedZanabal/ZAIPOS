import type { CartLine } from "./types";

/** Parse "1.250" BHD to fils without floating drift. */
export function bhdToFils(v: number | string): number {
  const s = typeof v === "number" ? v.toFixed(3) : v.trim();
  const neg = s.startsWith("-");
  const [i, f = ""] = s.replace("-", "").split(".");
  const fils = Number(i) * 1000 + Number((f + "000").slice(0, 3));
  return neg ? -fils : fils;
}
export function formatBhd(fils: number): string {
  const sign = fils < 0 ? "-" : "";
  const a = Math.abs(fils);
  return `${sign}BHD ${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, "0")}`;
}
/** Round half-up to the nearest fils for VAT. */
export const vatFils = (netFils: number, ratePct: number) => Math.round((netFils * ratePct) / 100);

export interface Quote {
  subtotalFils: number; // VAT-exclusive
  deliveryFeeFils: number;
  vatFils: number;
  totalFils: number;
  lines: { productId: string; qty: number; lineNetFils: number; lineVatFils: number }[];
}

export function quote(lines: CartLine[], deliveryFeeFils: number, deliveryVatPct = 10): Quote {
  const out = lines.map((l) => {
    const lineNetFils = Math.round(l.unitPriceFils * l.qty);
    return { productId: l.productId, qty: l.qty, lineNetFils, lineVatFils: vatFils(lineNetFils, l.taxRatePct) };
  });
  const subtotalFils = out.reduce((a, l) => a + l.lineNetFils, 0);
  const vat = out.reduce((a, l) => a + l.lineVatFils, 0) + vatFils(deliveryFeeFils, deliveryVatPct);
  return { subtotalFils, deliveryFeeFils, vatFils: vat, totalFils: subtotalFils + deliveryFeeFils + vat, lines: out };
}
