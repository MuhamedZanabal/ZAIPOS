import { describe, expect, it } from "vitest";
import { buildZReport, zReportLines } from "./zReport";

const session = { id: "5e55a0d1-0000-4000-8000-000000000001", opened_at: "2026-10-11T05:00:00Z", closed_at: "2026-10-11T19:00:00Z", status: "closed", opening_amount: "20.000", counted_cash: "24.845" };

describe("Z-report", () => {
  const sales = [
    { id: "a", status: "completed", channel: "pos", total: "1.100", tax_total: "0.100", discount_total: "0.000" },
    { id: "b", status: "partially_refunded", channel: "talabat", total: "5.830", tax_total: "0.530", discount_total: "0.200" },
    { id: "c", status: "voided", channel: "pos", total: "9.999", tax_total: "0.909" },
  ];
  const payments = [{ sale_id: "a", method: "cash", amount: "1.100" }, { sale_id: "b", method: "qr", amount: "5.830" }, { sale_id: "c", method: "cash", amount: "9.999" }];
  const returns = [{ amount: "0.550", method: "cash" }];
  const movements = [{ type: "in", amount: "5.000" }, { type: "out", amount: "0.700" }];

  it("adds up exactly in fils and excludes voided sales", () => {
    const r = buildZReport(session, sales, payments, returns, movements);
    expect(r.saleCount).toBe(2);
    expect(r.voidCount).toBe(1);
    expect(r.grossFils).toBe(6930);
    expect(r.vatFils).toBe(630);
    expect(r.refundFils).toBe(550);
    expect(r.netFils).toBe(6380);
    expect(r.netVatFils).toBe(630 - 50);
    expect(r.byMethodFils).toEqual({ cash: 1100, qr: 5830 });
    expect(r.byChannelFils).toEqual({ pos: 1100, talabat: 5830 });
    // 20.000 + 1.100 + 5.000 - 0.700 - 0.550
    expect(r.expectedCashFils).toBe(24850);
    expect(r.cashDifferenceFils).toBe(-5);
  });

  it("prints labelled BHD lines with three decimals", () => {
    const text = zReportLines(buildZReport(session, sales, payments, returns, movements), "Seef Café").join("\n");
    expect(text).toContain("Z-REPORT (END OF DAY)");
    expect(text).toMatch(/NET SALES\s+BHD 6\.380/);
    expect(text).toMatch(/BenefitPay\s+BHD 5\.830/);
    expect(text).toMatch(/Difference\s+BHD -0\.005/);
  });

  it("handles an empty open session", () => {
    const r = buildZReport({ ...session, closed_at: null, counted_cash: null }, [], [], [], []);
    expect(r.netFils).toBe(0);
    expect(r.expectedCashFils).toBe(20000);
    expect(r.cashDifferenceFils).toBeNull();
  });
});

describe("buildZReport discounts", () => {
  it("adds pre-VAT line discounts to ticket discounts", () => {
    const r = buildZReport(
      { id: "s", opened_at: "2026-10-11T05:00:00Z", closed_at: null, status: "open", opening_amount: "0" },
      [{ id: "a", status: "completed", total: "2.970", tax_total: "0.270", discount_total: "0.100", sale_items: [{ discount: "0.300" }, { discount: null }] }],
      [], [], [],
    );
    expect(r.discountFils).toBe(400);
  });
});
