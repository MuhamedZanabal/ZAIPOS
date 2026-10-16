import { describe, expect, it } from "vitest";
import { buildReceiptTextLines, formatBhdReceiptAmount, receiptDocumentTitle } from "../../electron/services/receipt-format";

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

  const base = {
    ticketNumber: 101, businessName: "Seef Café", branchName: "Seef",
    items: [{ name: "Karak", quantity: 2, unitPrice: 0.2, discountAmount: 0, taxRate: 10, total: 0.4 }],
    subtotal: 0.4, discountTotal: 0, tipAmount: 0, taxTotal: 0.04, total: 0.44,
    payments: [{ method: "cash", amount: 0.44 }], date: "2026-10-11T09:00:00Z",
  };

  it("issues an NBR simplified tax invoice with the seller TRN when VAT-registered", () => {
    const text = buildReceiptTextLines({ ...base, vatNumber: "220000000000003" }, 42).join("\n");
    expect(text).toContain("SIMPLIFIED TAX INVOICE");
    expect(text).toContain("VAT Reg. No (TRN): 220000000000003");
    expect(text).toContain("Invoice #101");
    expect(text).toMatch(/VAT 10%\s+BHD 0\.040/);
    expect(text).toMatch(/TOTAL \(incl\. VAT\)\s+BHD 0\.440/);
  });

  it("uses a full tax invoice above BHD 500 or for a VAT-registered buyer, and a plain receipt without a TRN", () => {
    expect(receiptDocumentTitle({ vatNumber: "1", total: 500.001 })).toBe("TAX INVOICE");
    expect(receiptDocumentTitle({ vatNumber: "1", total: 500 })).toBe("SIMPLIFIED TAX INVOICE");
    expect(receiptDocumentTitle({ vatNumber: "1", customerVatNumber: "2", total: 5 })).toBe("TAX INVOICE");
    expect(receiptDocumentTitle({ total: 900 })).toBe("RECEIPT");
    const text = buildReceiptTextLines(base, 42).join("\n");
    expect(text).not.toContain("TAX INVOICE");
    expect(text).toContain("Receipt #101");
  });
});
