import { useEffect } from "react";
import { publishCustomerDisplay } from "@/lib/customerDisplay";
import { effectiveCartUnitPrice, linesWithTicketDiscount, useCart } from "@/stores/cart";

const fils = (bhd: number) => Math.round(bhd * 1000);

/** Mirrors the open ticket to the customer display (see src/lib/customerDisplay.ts). */
export function useCustomerDisplayFeed(businessName?: string) {
  const lines = useCart((s) => s.lines);
  const ticket = useCart((s) => s.ticketDiscount);
  useEffect(() => {
    const priced = linesWithTicketDiscount(lines, ticket);
    const net = priced.map((l) => fils(effectiveCartUnitPrice(l) * l.quantity) - fils(l.discount));
    const vat = priced.reduce((sum, l, i) => sum + Math.round((net[i] * Number(l.product.tax_rate || 0)) / 100), 0);
    const subtotal = net.reduce((a, b) => a + b, 0);
    publishCustomerDisplay({
      status: lines.length ? "active" : "idle",
      businessName,
      lines: priced.map((l, i) => ({ name: l.product.name, quantity: l.quantity, totalFils: net[i] })),
      discountFils: priced.reduce((sum, l) => sum + fils(l.discount), 0),
      vatFils: vat,
      totalFils: subtotal + vat,
    });
  }, [lines, ticket, businessName]);
}

/** Shows the thank-you screen with the charged total, then returns to idle. */
export function showPaidOnCustomerDisplay(totalFils: number, changeFils: number, businessName?: string) {
  publishCustomerDisplay({ status: "paid", businessName, lines: [], discountFils: 0, vatFils: 0, totalFils, changeFils });
  window.setTimeout(() => {
    if (useCart.getState().lines.length === 0) {
      publishCustomerDisplay({ status: "idle", businessName, lines: [], discountFils: 0, vatFils: 0, totalFils: 0 });
    }
  }, 8000);
}
