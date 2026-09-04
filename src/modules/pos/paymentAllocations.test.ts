import { describe, expect, it } from "vitest";
import {
  addPaymentAllocation,
  allocationTotalFils,
  normalizePaymentAllocations,
  remainingPaymentFils,
  type PaymentAllocation,
} from "./paymentAllocations";

const payments = (...rows: PaymentAllocation[]) => rows;

describe("payment allocations", () => {
  it("sums split payments exactly in fils", () => {
    expect(allocationTotalFils(payments(
      { method: "cash", amountFils: 1250, reference: null },
      { method: "card", amountFils: 2000, reference: null },
      { method: "qr", amountFils: 750, reference: "BP-1" },
    ))).toBe(4000);
  });

  it("calculates exact remaining amount", () => {
    expect(remainingPaymentFils(5000, payments(
      { method: "cash", amountFils: 1250, reference: null },
      { method: "card", amountFils: 2000, reference: null },
    ))).toBe(1750);
  });

  it("rejects zero, negative and over-allocations", () => {
    const base = payments({ method: "cash", amountFils: 1000, reference: null });
    expect(() => addPaymentAllocation(base, { method: "card", amountFils: 0, reference: null }, 2000)).toThrow();
    expect(() => addPaymentAllocation(base, { method: "card", amountFils: -1, reference: null }, 2000)).toThrow();
    expect(() => addPaymentAllocation(base, { method: "card", amountFils: 1001, reference: null }, 2000)).toThrow();
  });

  it("merges same-method allocations only when their references match", () => {
    expect(addPaymentAllocation(
      payments({ method: "cash", amountFils: 1000, reference: null }),
      { method: "cash", amountFils: 500, reference: null },
      2000,
    )).toEqual([{ method: "cash", amountFils: 1500, reference: null }]);

    expect(addPaymentAllocation(
      payments({ method: "qr", amountFils: 1000, reference: "A" }),
      { method: "qr", amountFils: 500, reference: "B" },
      2000,
    )).toHaveLength(2);
  });

  it("normalizes payloads to exact three-decimal BHD amounts", () => {
    expect(normalizePaymentAllocations(payments(
      { method: "cash", amountFils: 1250, reference: null },
      { method: "qr", amountFils: 1, reference: "BP" },
    ))).toEqual([
      { method: "cash", amount: 1.25, reference: null },
      { method: "qr", amount: 0.001, reference: "BP" },
    ]);
  });
});
