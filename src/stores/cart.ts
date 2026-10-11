import { create } from "zustand";
import { allocateFils, discountFils, type DiscountMode } from "@/lib/discounts";
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
  /** Manager PIN verification operation authorising a discount above the threshold. */
  discountApprovalId?: string;
}

export interface TicketDiscount {
  mode: DiscountMode;
  value: number;
}

interface CartState {
  lines: CartLine[];
  ticketDiscount: TicketDiscount | null;
  discountApprovalId: string | null;
  setTicketDiscount: (d: TicketDiscount | null) => void;
  setDiscountApproval: (id: string | null) => void;
  add: (p: CartProduct) => void;
  /** Adds a measured quantity (e.g. 0.750 kg). Rounded to 3 decimals. */
  addQuantity: (p: CartProduct, quantity: number) => void;
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
  ticketDiscount: null,
  discountApprovalId: null,
  setTicketDiscount: (d) => set({ ticketDiscount: d }),
  setDiscountApproval: (id) => set({ discountApprovalId: id }),
  add: (p) =>
    set((s) => {
      const lineId = getLineId(p);
      const existing = s.lines.find((l) => l.id === lineId);
      if (existing)
        return { lines: s.lines.map((l) => (l.id === lineId ? { ...l, quantity: l.quantity + 1, priceOverride: undefined } : l)) };
      return { lines: [...s.lines, { id: lineId, product: p, quantity: 1, discount: 0 }] };
    }),
  addQuantity: (p, quantity) =>
    set((s) => {
      const q = Math.round(quantity * 1000) / 1000;
      if (!(q > 0)) return s;
      const lineId = getLineId(p);
      const existing = s.lines.find((l) => l.id === lineId);
      if (existing)
        return { lines: s.lines.map((l) => (l.id === lineId ? { ...l, quantity: Math.round((l.quantity + q) * 1000) / 1000, priceOverride: undefined } : l)) };
      return { lines: [...s.lines, { id: lineId, product: p, quantity: q, discount: 0 }] };
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
  clear: () => set({ lines: [], ticketDiscount: null, discountApprovalId: null }),
  subtotal: () => checkoutLines(get()).reduce((sum, l) => sum + effectiveCartUnitPrice(l) * l.quantity - l.discount, 0),
  taxTotal: () =>
    checkoutLines(get()).reduce((sum, l) => {
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

const toFils = (bhd: number) => Math.round(bhd * 1000);

/** Gross (pre-discount, pre-VAT) line amount in fils. */
export function lineGrossFils(line: CartLine): number {
  return toFils(effectiveCartUnitPrice(line) * line.quantity);
}

/** Whole-ticket discount in fils, applied to the net of line discounts, before VAT. */
export function ticketDiscountFils(lines: CartLine[], ticket: TicketDiscount | null): number {
  if (!ticket) return 0;
  const net = lines.reduce((s, l) => s + Math.max(0, lineGrossFils(l) - toFils(l.discount || 0)), 0);
  return discountFils(net, ticket.mode, ticket.value);
}

/**
 * Lines as sent to checkout: the ticket discount is allocated pre-VAT across
 * lines in proportion to their net, fils-exact, and folded into each line
 * discount so the server computes VAT on the discounted net.
 */
export function linesWithTicketDiscount(
  lines: CartLine[],
  ticket: TicketDiscount | null,
  approvalId: string | null = null,
): CartLine[] {
  const nets = lines.map((l) => Math.max(0, lineGrossFils(l) - toFils(l.discount || 0)));
  const shares = allocateFils(nets, ticketDiscountFils(lines, ticket));
  return lines.map((l, i) => {
    const discount = (toFils(l.discount || 0) + shares[i]) / 1000;
    return discount > 0 && approvalId ? { ...l, discount, discountApprovalId: approvalId } : { ...l, discount };
  });
}

function checkoutLines(s: Pick<CartState, "lines" | "ticketDiscount" | "discountApprovalId">): CartLine[] {
  return linesWithTicketDiscount(s.lines, s.ticketDiscount, s.discountApprovalId);
}
