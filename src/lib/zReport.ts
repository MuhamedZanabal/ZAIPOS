import { bhdToFils, filsToBhd } from "@/lib/bahrain";

/** All amounts are integer fils so the report adds up exactly. */
export interface ZSession {
  id: string; opened_at: string; closed_at: string | null; status: string;
  opening_amount: number | string; counted_cash?: number | string | null;
  counted_card?: number | string | null; counted_transfer?: number | string | null; counted_qr?: number | string | null;
}
export interface ZSale { id: string; status: string; channel?: string | null; total: number | string; tax_total?: number | string | null; discount_total?: number | string | null; sale_items?: Array<{ discount?: number | string | null }> | null }
export interface ZPayment { sale_id: string; method: string; amount: number | string }
export interface ZReturn { amount: number | string; method?: string | null }
export interface ZMovement { type: string; amount: number | string }

export interface ZReport {
  sessionId: string; openedAt: string; closedAt: string | null;
  saleCount: number; voidCount: number;
  grossFils: number; discountFils: number; vatFils: number; refundFils: number; netFils: number; netVatFils: number;
  byMethodFils: Record<string, number>; byChannelFils: Record<string, number>;
  openingFils: number; cashInFils: number; cashOutFils: number; cashRefundFils: number;
  expectedCashFils: number; countedCashFils: number | null; cashDifferenceFils: number | null;
}

const fils = (value: number | string | null | undefined) => (value == null || value === "" ? 0 : bhdToFils(value));
const COUNTABLE = new Set(["completed", "partially_refunded", "refunded"]);

export function buildZReport(session: ZSession, sales: ZSale[], payments: ZPayment[], returns: ZReturn[], movements: ZMovement[]): ZReport {
  const counted = sales.filter((s) => COUNTABLE.has(s.status));
  const countedIds = new Set(counted.map((s) => s.id));
  const grossFils = counted.reduce((sum, s) => sum + fils(s.total), 0);
  const vatFils = counted.reduce((sum, s) => sum + fils(s.tax_total), 0);
  const refundFils = returns.reduce((sum, r) => sum + fils(r.amount), 0);
  const netFils = grossFils - refundFils;
  // VAT on refunds is reversed proportionally (NBR credit-note treatment), rounded to the fils.
  const netVatFils = grossFils > 0 ? vatFils - Math.round((vatFils * refundFils) / grossFils) : 0;

  const byMethodFils: Record<string, number> = {};
  for (const p of payments) if (countedIds.has(p.sale_id)) byMethodFils[p.method] = (byMethodFils[p.method] ?? 0) + fils(p.amount);
  const byChannelFils: Record<string, number> = {};
  for (const s of counted) { const c = s.channel || "pos"; byChannelFils[c] = (byChannelFils[c] ?? 0) + fils(s.total); }

  const cashInFils = movements.filter((m) => m.type === "in").reduce((sum, m) => sum + fils(m.amount), 0);
  const cashOutFils = movements.filter((m) => m.type === "out").reduce((sum, m) => sum + fils(m.amount), 0);
  const cashRefundFils = returns.filter((r) => (r.method ?? "cash") === "cash").reduce((sum, r) => sum + fils(r.amount), 0);
  const openingFils = fils(session.opening_amount);
  const expectedCashFils = openingFils + (byMethodFils.cash ?? 0) + cashInFils - cashOutFils - cashRefundFils;
  const countedCashFils = session.counted_cash == null ? null : fils(session.counted_cash);

  return {
    sessionId: session.id, openedAt: session.opened_at, closedAt: session.closed_at,
    saleCount: counted.length, voidCount: sales.filter((s) => s.status === "voided" || s.status === "cancelled").length,
    grossFils, discountFils: counted.reduce((sum, s) => sum + fils(s.discount_total) + (s.sale_items ?? []).reduce((a, i) => a + fils(i.discount), 0), 0), vatFils, refundFils, netFils, netVatFils,
    byMethodFils, byChannelFils, openingFils, cashInFils, cashOutFils, cashRefundFils,
    expectedCashFils, countedCashFils, cashDifferenceFils: countedCashFils == null ? null : countedCashFils - expectedCashFils,
  };
}

const METHOD_LABEL: Record<string, string> = { cash: "Cash", card: "Card", qr: "BenefitPay", benefitpay: "BenefitPay", transfer: "Bank transfer", credit: "Customer credit" };
const CHANNEL_LABEL: Record<string, string> = { pos: "Counter", tables: "Tables", talabat: "Talabat", whatsapp: "WhatsApp", delivery: "Delivery" };

/** Plain-text Z-report, one entry per line, suitable for thermal printing or a print dialog. */
export function zReportLines(report: ZReport, businessName: string, width = 42): string[] {
  const bhd = (value: number) => `BHD ${filsToBhd(value)}`;
  const row = (left: string, value: number) => { const right = bhd(value); return left + " ".repeat(Math.max(1, width - left.length - right.length)) + right; };
  const sep = "-".repeat(width);
  const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-BH", { dateStyle: "short", timeStyle: "short", hour12: false, timeZone: "Asia/Bahrain" }).format(new Date(iso)) : "open");
  const lines = [businessName.toUpperCase(), "Z-REPORT (END OF DAY)", `Opened: ${time(report.openedAt)}`, `Closed: ${time(report.closedAt)}`, `Session: ${report.sessionId.slice(0, 8)}`, sep,
    `Sales: ${report.saleCount}   Voided: ${report.voidCount}`,
    row("Gross sales (incl. VAT)", report.grossFils), row("Discounts given", report.discountFils), row("Refunds", report.refundFils),
    row("NET SALES", report.netFils), row("VAT collected (net)", report.netVatFils), row("Net excl. VAT", report.netFils - report.netVatFils), sep, "By payment method:"];
  for (const [m, v] of Object.entries(report.byMethodFils).sort()) lines.push(row(`  ${METHOD_LABEL[m] ?? m}`, v));
  lines.push(sep, "By channel:");
  for (const [c, v] of Object.entries(report.byChannelFils).sort()) lines.push(row(`  ${CHANNEL_LABEL[c] ?? c}`, v));
  lines.push(sep, "Cash drawer:", row("  Opening float", report.openingFils), row("  Cash sales", report.byMethodFils.cash ?? 0),
    row("  Paid in", report.cashInFils), row("  Paid out", report.cashOutFils), row("  Cash refunds", report.cashRefundFils), row("  EXPECTED CASH", report.expectedCashFils));
  if (report.countedCashFils != null && report.cashDifferenceFils != null) lines.push(row("  Counted cash", report.countedCashFils), row("  Difference", report.cashDifferenceFils));
  return lines;
}
