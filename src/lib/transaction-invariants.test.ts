import { describe, expect, it } from "vitest";
import * as bahrainModule from "./bahrain";

type InvariantApi = {
  sumPaymentAllocationsFils?: (payments: ReadonlyArray<{ amountFils: number }>) => number;
  assertPaymentsReconcileFils?: (
    payableTotalFils: number,
    payments: ReadonlyArray<{ amountFils: number }>,
  ) => number;
  expectedTillCashFils?: (input: {
    openingCashFils: number;
    cashSalesFils: number;
    cashInFils: number;
    cashRefundsFils: number;
    cashOutFils: number;
  }) => number;
  remainingRefundableFils?: (saleTotalFils: number, alreadyRefundedFils: number) => number;
  assertRefundAllowedFils?: (
    saleTotalFils: number,
    alreadyRefundedFils: number,
    requestedRefundFils: number,
  ) => number;
};

const invariants = bahrainModule as typeof bahrainModule & InvariantApi;

describe("P0 transaction invariants", () => {
  it("sums split payment allocations exactly in fils", () => {
    const payments = [
      { amountFils: 5_000 },
      { amountFils: 3_500 },
      { amountFils: 7_150 },
    ];

    expect(invariants.sumPaymentAllocationsFils?.(payments)).toBe(15_650);
  });

  it("rejects a split payment mismatch of a single fils", () => {
    const payments = [{ amountFils: 5_000 }, { amountFils: 5_001 }];

    expect(() => invariants.assertPaymentsReconcileFils?.(10_000, payments)).toThrow(
      /payment allocations.*1 fils/i,
    );
  });

  it("returns the reconciled payment total", () => {
    const payments = [{ amountFils: 5_000 }, { amountFils: 5_000 }];

    expect(invariants.assertPaymentsReconcileFils?.(10_000, payments)).toBe(10_000);
  });

  it("rejects negative payment allocations", () => {
    expect(() => invariants.sumPaymentAllocationsFils?.([
      { amountFils: 10_001 },
      { amountFils: -1 },
    ])).toThrow(/payment allocation.*non-negative/i);
  });

  it("derives expected till cash from cash-only effects", () => {
    expect(invariants.expectedTillCashFils?.({
      openingCashFils: 10_000,
      cashSalesFils: 5_000,
      cashInFils: 2_000,
      cashRefundsFils: 500,
      cashOutFils: 1_000,
    })).toBe(15_500);
  });

  it("calculates the remaining refundable value", () => {
    expect(invariants.remainingRefundableFils?.(10_000, 3_000)).toBe(7_000);
  });

  it("rejects refunds above the remaining refundable value", () => {
    expect(() => invariants.assertRefundAllowedFils?.(10_000, 3_000, 7_001)).toThrow(
      /exceeds.*7\.000/i,
    );
  });

  it("accepts a refund equal to the remaining refundable value", () => {
    expect(invariants.assertRefundAllowedFils?.(10_000, 3_000, 7_000)).toBe(7_000);
  });

  it("rejects a zero or negative refund request", () => {
    expect(() => invariants.assertRefundAllowedFils?.(10_000, 3_000, 0)).toThrow(
      /refund.*positive/i,
    );
    expect(() => invariants.assertRefundAllowedFils?.(10_000, 3_000, -1)).toThrow(
      /refund.*positive/i,
    );
  });
});
