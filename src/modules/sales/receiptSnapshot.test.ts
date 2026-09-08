import { describe, expect, it } from "vitest";
import { buildHistoricalReceiptTicket } from "./receiptSnapshot";

describe("historical receipt snapshot mapping", () => {
  it("builds a reprint exclusively from immutable persisted fils and historical labels", () => {
    const ticket = buildHistoricalReceiptTicket({
      event_id: "90000000-0000-0000-0000-000000000073",
      current_status: "partially_refunded",
      snapshot: {
        ticket_number: 73,
        transaction_time: "2026-09-05T09:00:00Z",
        business: { name: "Amwaj Al Dair", receipt_config: { footer_text: "Visit again" } },
        branch: { name: "Muharraq", address: "Road 100", phone: "+973 1700 0000" },
        cashier: { id: "30000000-0000-0000-0000-000000000073", name: "Zana" },
        customer: { id: "80000000-0000-0000-0000-000000000073", name: "Customer A", phone: "+973 3900 0000" },
        totals: {
          subtotal_fils: 2500,
          discount_total_fils: 250,
          tax_total_fils: 225,
          tip_amount_fils: 25,
          total_fils: 2500,
        },
        items: [{
          id: "70000000-0000-0000-0000-000000000073",
          name: "Historical product name",
          quantity: 2,
          unit_price_fils: 1250,
          discount_fils: 250,
          line_total_fils: 2475,
          tax_rate: 10,
        }],
        payments: [
          { id: "71000000-0000-0000-0000-000000000073", method: "cash", amount_fils: 1000, reference: null },
          { id: "71000000-0000-0000-0000-000000000074", method: "qr", amount_fils: 1500, reference: "BP-73" },
        ],
      },
    });

    expect(ticket).toEqual({
      ticketNumber: 73,
      businessName: "Amwaj Al Dair",
      branchName: "Muharraq",
      address: "Road 100",
      phone: "+973 1700 0000",
      cashierName: "Zana",
      customerName: "Customer A",
      items: [{
        name: "Historical product name",
        quantity: 2,
        unitPrice: 1.25,
        discountAmount: 0.25,
        taxRate: 10,
        total: 2.475,
      }],
      subtotal: 2.5,
      discountTotal: 0.25,
      taxTotal: 0.225,
      tipAmount: 0.025,
      total: 2.5,
      payments: [
        { method: "cash", amount: 1, reference: undefined },
        { method: "qr", amount: 1.5, reference: "BP-73" },
      ],
      notes: "Visit again",
      date: "2026-09-05T09:00:00Z",
      isReprint: true,
      saleStatus: "partially_refunded",
      reprintEventId: "90000000-0000-0000-0000-000000000073",
    });
  });
});
