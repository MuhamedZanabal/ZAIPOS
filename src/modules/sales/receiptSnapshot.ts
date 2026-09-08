import { filsToBhd } from "@/lib/bahrain";
import type { TicketData } from "@/lib/hardware";

type ReceiptItemSnapshot = {
  id: string;
  name: string;
  quantity: number;
  unit_price_fils: number;
  discount_fils: number;
  line_total_fils: number;
  tax_rate: number;
};

type ReceiptPaymentSnapshot = {
  id: string;
  method: string;
  amount_fils: number;
  reference: string | null;
};

export type PreparedReceiptReprint = {
  event_id: string;
  current_status: string;
  snapshot: {
    ticket_number: string | number;
    transaction_time: string;
    business: { name: string; receipt_config: Record<string, unknown> };
    branch: { name: string; address: string | null; phone: string | null };
    cashier: { id: string; name: string };
    customer: { id: string; name: string; phone: string | null } | null;
    totals: {
      subtotal_fils: number;
      discount_total_fils: number;
      tax_total_fils: number;
      tip_amount_fils: number;
      total_fils: number;
    };
    items: ReceiptItemSnapshot[];
    payments: ReceiptPaymentSnapshot[];
  };
};

function exactBhd(fils: number, label: string): number {
  if (!Number.isSafeInteger(fils)) {
    throw new TypeError(`${label} must be an exact integer number of fils`);
  }
  return Number(filsToBhd(fils));
}

export function buildHistoricalReceiptTicket(prepared: PreparedReceiptReprint): TicketData {
  const { snapshot } = prepared;
  if (!prepared.event_id || !snapshot?.business?.name || !snapshot?.branch?.name) {
    throw new TypeError("Historical receipt snapshot is incomplete");
  }

  const footer = snapshot.business.receipt_config?.footer_text;

  return {
    ticketNumber: snapshot.ticket_number,
    businessName: snapshot.business.name,
    branchName: snapshot.branch.name,
    address: snapshot.branch.address ?? undefined,
    phone: snapshot.branch.phone ?? undefined,
    cashierName: snapshot.cashier.name,
    customerName: snapshot.customer?.name,
    items: snapshot.items.map((item) => ({
      name: item.name,
      quantity: Number(item.quantity),
      unitPrice: exactBhd(Number(item.unit_price_fils), "Receipt item unit price"),
      discountAmount: exactBhd(Number(item.discount_fils), "Receipt item discount"),
      taxRate: Number(item.tax_rate),
      total: exactBhd(Number(item.line_total_fils), "Receipt item total"),
    })),
    subtotal: exactBhd(Number(snapshot.totals.subtotal_fils), "Receipt subtotal"),
    discountTotal: exactBhd(Number(snapshot.totals.discount_total_fils), "Receipt discount"),
    taxTotal: exactBhd(Number(snapshot.totals.tax_total_fils), "Receipt VAT"),
    tipAmount: exactBhd(Number(snapshot.totals.tip_amount_fils), "Receipt tip"),
    total: exactBhd(Number(snapshot.totals.total_fils), "Receipt total"),
    payments: snapshot.payments.map((payment) => ({
      method: payment.method,
      amount: exactBhd(Number(payment.amount_fils), "Receipt payment"),
      reference: payment.reference ?? undefined,
    })),
    notes: typeof footer === "string" && footer.trim() ? footer : undefined,
    date: snapshot.transaction_time,
    isReprint: true,
    saleStatus: prepared.current_status,
    reprintEventId: prepared.event_id,
  };
}
