import { create } from "zustand";
import type { Database } from "@/integrations/supabase/types";

type Product = Database["public"]["Tables"]["products"]["Row"];

export interface CartModifier {
  option_id: string;
  group_id: string;
  name: string;
  price_delta: number;
}

export type CartProduct = Product & {
  _modifiers?: CartModifier[];
};

export interface PriceOverrideEvidence {
  requestId: string;
  originalUnitPriceFils: number;
  overrideUnitPriceFils: number;
  approvedQuantity: number;
  reason: string;
  approvedBy: string;
  approvedAt: string;
}

export interface CartLine {
  id: string;
  product: CartProduct;
  quantity: number;
  discount: number;
  priceOverride?: PriceOverrideEvidence;
}

interface CartState {
  lines: CartLine[];
  add: (p: CartProduct) => void;
  remove: (id: string) => void;
  setQty: (id: string, q: number) => void;
  setDiscount: (id: string, d: number) => void;
  setPriceOverride: (id: string, evidence: PriceOverrideEvidence | undefined) => void;
  clearPriceOverrides: () => void;
  replace: (lines: CartLine[]) => void;
  clear: () => void;
  subtotal: () => number;
  taxTotal: () => number;
  total: () => number;
}

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  add: (p) =>
    set((s) => {
      const lineId = getLineId(p);
      const existing = s.lines.find((l) => l.id === lineId);
      if (existing)
        return { lines: s.lines.map((l) => (l.id === lineId ? { ...l, quantity: l.quantity + 1, priceOverride: undefined } : l)) };
      return { lines: [...s.lines, { id: lineId, product: p, quantity: 1, discount: 0 }] };
    }),
  remove: (id) => set((s) => ({ lines: s.lines.filter((l) => l.id !== id) })),
  setQty: (id, q) =>
    set((s) => ({
      lines: q <= 0 ? s.lines.filter((l) => l.id !== id) : s.lines.map((l) => (
        l.id === id
          ? { ...l, quantity: q, priceOverride: l.priceOverride && q <= l.priceOverride.approvedQuantity ? l.priceOverride : undefined }
          : l
      )),
    })),
  setDiscount: (id, d) => set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, discount: d } : l)) })),
  setPriceOverride: (id, evidence) => set((s) => ({
    lines: s.lines.map((line) => (line.id === id ? { ...line, priceOverride: evidence } : line)),
  })),
  clearPriceOverrides: () => set((s) => ({
    lines: s.lines.map((line) => line.priceOverride ? { ...line, priceOverride: undefined } : line),
  })),
  replace: (lines) => set({ lines }),
  clear: () => set({ lines: [] }),
  subtotal: () => get().lines.reduce((sum, l) => sum + effectiveCartUnitPrice(l) * l.quantity - l.discount, 0),
  taxTotal: () =>
    get().lines.reduce((sum, l) => {
      const base = effectiveCartUnitPrice(l) * l.quantity - l.discount;
      return sum + (base * Number(l.product.tax_rate || 0)) / 100;
    }, 0),
  total: () => get().subtotal() + get().taxTotal(),
}));

export function effectiveCartUnitPrice(line: CartLine): number {
  return line.priceOverride ? line.priceOverride.overrideUnitPriceFils / 1000 : Number(line.product.price);
}

function getLineId(product: CartProduct): string {
  const modifiers = product._modifiers ?? [];
  if (modifiers.length === 0) return product.id;

  const modifierKey = modifiers
    .map((modifier) => modifier.option_id)
    .sort()
    .join(",");

  return `${product.id}:${modifierKey}`;
}
