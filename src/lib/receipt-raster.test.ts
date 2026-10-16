import { describe, expect, it } from "vitest";
import { bitmapToEscPosRaster, contentHeight, buildBilingualReceiptHtml, receiptDotWidth, RECEIPT_AR } from "../../electron/services/receipt-raster";

const ticket = {
  ticketNumber: 101, businessName: "مقهى السيف · Seef Café", branchName: "Seef",
  items: [{ name: "كرك Karak", quantity: 2, unitPrice: 0.2, discountAmount: 0, taxRate: 10, total: 0.4 }],
  subtotal: 0.4, discountTotal: 0, tipAmount: 0, taxTotal: 0.04, total: 0.44,
  payments: [{ method: "qr", amount: 0.44 }], date: "2026-10-11T09:00:00Z", vatNumber: "220000000000003",
};

describe("bilingual raster receipt", () => {
  it("lays out NBR fields in English and Arabic without network resources", () => {
    const html = buildBilingualReceiptHtml(ticket, 576, { regular: "AAAA", bold: "BBBB" });
    for (const s of ["SIMPLIFIED TAX INVOICE", "فاتورة ضريبية مبسطة", "VAT Reg. No (TRN)", "رقم التسجيل الضريبي", "220000000000003", "#101", "BHD 0.440", "الإجمالي شامل الضريبة", "VAT 10%", "بنفت باي", "كرك Karak"]) expect(html).toContain(s);
    expect(html).toContain("data:font/woff2;base64,AAAA");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("width:576px");
  });

  it("escapes user text", () => {
    const html = buildBilingualReceiptHtml({ ...ticket, notes: "<script>x</script>" }, 384);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("every receipt label has an Arabic translation", () => {
    for (const [en, ar] of Object.entries(RECEIPT_AR)) expect(/[\u0600-\u06FF]/.test(ar), en).toBe(true);
    expect(receiptDotWidth(42)).toBe(576);
    expect(receiptDotWidth(32)).toBe(384);
  });

  it("packs pixels into GS v 0 raster bytes, MSB = leftmost dot", () => {
    // 10x2 bitmap: row 0 = black at x=0 and x=9; row 1 = all white. RGBA.
    const w = 10, h = 2, px = new Uint8Array(w * h * 4).fill(255);
    for (const x of [0, 9]) px.set([0, 0, 0, 255], x * 4);
    const out = bitmapToEscPosRaster(w, h, px);
    expect([...out.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...out.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
    expect([...out.subarray(10)]).toEqual([0b10000000, 0b01000000, 0, 0]);
  });

  it("handles BGRA order, transparency and banding", () => {
    const w = 8, h = 3, px = new Uint8Array(w * h * 4);
    // fully transparent → white; one opaque pure-blue pixel in BGRA is dark
    px.set([255, 0, 0, 255], 0);
    const out = bitmapToEscPosRaster(w, h, px, { bgra: true, band: 2 });
    expect([...out.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0]);
    expect(out[10]).toBe(0x80);
    expect([...out.subarray(12, 20)]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0]);
    expect(() => bitmapToEscPosRaster(4, 4, new Uint8Array(4))).toThrow(RangeError);
  });

  it("trims blank space below the receipt", () => {
    const w = 4, h = 6, px = new Uint8Array(w * h * 4).fill(255);
    px.set([0, 0, 0, 255], (2 * w + 1) * 4);
    expect(contentHeight(w, h, px)).toBe(3);
    expect(contentHeight(w, h, new Uint8Array(w * h * 4).fill(255))).toBe(0);
  });
});
