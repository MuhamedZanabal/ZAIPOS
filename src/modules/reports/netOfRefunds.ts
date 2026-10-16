import { roundBhd } from "@/lib/bahrain";

/** Sale statuses that still carry (part of) their revenue. Fully refunded sales net to zero. */
export const REPORTABLE_SALE_STATUSES = ["completed", "partially_refunded", "refunded"] as const;

export interface ReportSale { id: string; total: number | string; tax_total?: number | string | null; created_at: string }
export interface ReportItem { id: string; sale_id: string; product_name: string; quantity: number | string; line_total: number | string }
export interface ReportReturnItem { sale_item_id: string; quantity: number | string; amount: number | string }

export interface NetSale { id: string; created_at: string; total: number; tax: number }
export interface NetProduct { name: string; qty: number; total: number }

/**
 * Applies recorded returns to sales and items so reports show revenue net of
 * refunds instead of dropping partially refunded sales entirely.
 */
export function netOfRefunds(sales: ReportSale[], items: ReportItem[], returns: ReportReturnItem[]) {
  const returnedQty = new Map<string, number>();
  const returnedAmount = new Map<string, number>();
  for (const r of returns) {
    returnedQty.set(r.sale_item_id, (returnedQty.get(r.sale_item_id) ?? 0) + Number(r.quantity));
    returnedAmount.set(r.sale_item_id, (returnedAmount.get(r.sale_item_id) ?? 0) + Number(r.amount));
  }
  const refundBySale = new Map<string, number>();
  const products: Record<string, NetProduct> = {};
  for (const it of items) {
    const refunded = returnedAmount.get(it.id) ?? 0;
    refundBySale.set(it.sale_id, (refundBySale.get(it.sale_id) ?? 0) + refunded);
    const qty = Number(it.quantity) - (returnedQty.get(it.id) ?? 0);
    const total = roundBhd(Number(it.line_total) - refunded);
    if (qty <= 0 && total <= 0) continue;
    products[it.product_name] ??= { name: it.product_name, qty: 0, total: 0 };
    products[it.product_name].qty += qty;
    products[it.product_name].total = roundBhd(products[it.product_name].total + total);
  }
  const netSales: NetSale[] = [];
  let refundTotal = 0;
  for (const s of sales) {
    const gross = Number(s.total);
    const refund = Math.min(gross, refundBySale.get(s.id) ?? 0);
    refundTotal = roundBhd(refundTotal + refund);
    const total = roundBhd(gross - refund);
    if (total <= 0) continue;
    const tax = gross > 0 ? roundBhd(Number(s.tax_total || 0) * (total / gross)) : 0;
    netSales.push({ id: s.id, created_at: s.created_at, total, tax });
  }
  return { sales: netSales, products: Object.values(products), refundTotal };
}
