import { describe, expect, it } from "vitest";
import { buildReceiptTextLines, formatBhdReceiptAmount } from "../../electron/services/receipt-format";

describe("Bahrain receipt formatting", () => {
  it("formats BHD with exact three-decimal presentation", () => {
    expect(formatBhdReceiptAmount(0.025)).toBe("BHD 0.025");
    expect(formatBhdReceiptAmount(12.65)).toBe("BHD 12.650");
  });

  it("marks reprints and uses English Bahrain labels without legacy currency text", () => {
    const lines = buildReceiptTextLines({
      ticketNumber: 73,
      businessName: "Amwaj Al Dair",
      branchName: "Muharraq",
      cashierName: "Zana",
      items: [{ name: "Water", quantity: 2, unitPrice: 0.5, discountAmount: 0, taxRate: 10, total: 1.1 }],
      subtotal: 1,
      discountTotal: 0,
      tipAmount: 0,
      taxTotal: 0.1,
      total: 1.1,
      payments: [{ method: "qr", amount: 1.1 }],
      date: "2026-09-05T09:00:00Z",
      isReprint: true,
      saleStatus: "completed",
    }, 42);

    expect(lines.join("\n")).toContain("REPRINT");
    expect(lines.join("\n")).toContain("Cashier: Zana");
    expect(lines.join("\n")).toContain("VAT");
    expect(lines.join("\n")).toContain("BenefitPay");
    expect(lines.join("\n")).toContain("BHD 1.100");
    expect(lines.join("\n")).not.toMatch(/\$|IVA|Cambio|es-MX/);
  });
});
