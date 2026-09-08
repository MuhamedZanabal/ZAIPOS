import type { TicketData } from "../types.js";

function padLine(left: string, right: string, width: number): string {
  const spaces = width - left.length - right.length;
  return left + " ".repeat(Math.max(spaces, 1)) + right;
}

function paymentMethodLabel(method: string): string {
  const normalized = method.trim().toLowerCase();
  if (normalized === "cash") return "Cash";
  if (normalized === "card") return "Card";
  if (normalized === "qr" || normalized === "benefitpay") return "BenefitPay";
  if (normalized === "transfer" || normalized === "bank transfer") return "Bank Transfer";
  return method;
}

export function formatBhdReceiptAmount(amount: number): string {
  if (!Number.isFinite(amount)) throw new TypeError("Receipt amount must be finite");
  return `BHD ${amount.toFixed(3)}`;
}

export function buildReceiptTextLines(data: TicketData, width: number): string[] {
  const date = data.date ? new Date(data.date) : new Date();
  if (Number.isNaN(date.getTime())) throw new TypeError("Receipt date is invalid");

  const dateText = new Intl.DateTimeFormat("en-BH", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bahrain",
  }).format(date);
  const separator = "-".repeat(width);
  const lines: string[] = [data.businessName.toUpperCase()];

  if (data.branchName) lines.push(data.branchName);
  if (data.address) lines.push(data.address);
  if (data.phone) lines.push(`Tel: ${data.phone}`);
  if (data.isReprint) lines.push("*** REPRINT ***");

  lines.push(separator);
  lines.push(padLine(`Receipt #${data.ticketNumber}`, dateText, width));
  if (data.cashierName) lines.push(`Cashier: ${data.cashierName}`);
  if (data.customerName) lines.push(`Customer: ${data.customerName}`);
  if (data.isReprint && data.saleStatus && data.saleStatus !== "completed") {
    lines.push(`Current status: ${data.saleStatus.replaceAll("_", " ").toUpperCase()}`);
  }
  lines.push(separator);

  for (const item of data.items) {
    const quantity = Number.isInteger(item.quantity) ? String(item.quantity) : item.quantity.toFixed(3);
    const total = formatBhdReceiptAmount(item.total);
    const label = `${quantity}x ${item.name}`;
    const maxNameLength = Math.max(width - total.length - 2, 4);
    const displayName = label.length > maxNameLength
      ? `${label.slice(0, Math.max(maxNameLength - 1, 1))}…`
      : label;
    lines.push(padLine(displayName, total, width));
    lines.push(`   @ ${formatBhdReceiptAmount(item.unitPrice)} each`);
    if ((item.discountAmount ?? 0) > 0) {
      lines.push(`   Discount: -${formatBhdReceiptAmount(item.discountAmount ?? 0)}`);
    }
    if ((item.taxRate ?? 0) > 0) lines.push(`   VAT: ${item.taxRate}%`);
  }

  lines.push(separator);
  lines.push(padLine("Subtotal", formatBhdReceiptAmount(data.subtotal), width));
  if (data.discountTotal > 0) lines.push(padLine("Discount", `-${formatBhdReceiptAmount(data.discountTotal)}`, width));
  if (data.taxTotal > 0) lines.push(padLine("VAT", formatBhdReceiptAmount(data.taxTotal), width));
  if (data.tipAmount > 0) lines.push(padLine("Tip", formatBhdReceiptAmount(data.tipAmount), width));
  lines.push(padLine("TOTAL", formatBhdReceiptAmount(data.total), width));

  if (data.payments.length > 0) {
    lines.push(separator, "Payment methods:");
    for (const payment of data.payments) {
      lines.push(padLine(`  ${paymentMethodLabel(payment.method)}`, formatBhdReceiptAmount(payment.amount), width));
      if (payment.reference) lines.push(`    Ref: ${payment.reference}`);
    }
  }

  if (data.notes) lines.push(separator, data.notes);
  lines.push("Thank you for your business!");
  return lines;
}
