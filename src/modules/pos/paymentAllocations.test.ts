import { describe, expect, it } from "vitest";
import {
  addPaymentAllocation,
  paymentAllocationsToBhdRows,
  remainingPaymentFils,
  type PaymentAllocation,
} from "./paymentAllocations";

describe("split payment allocations", () => {
  it("tracks the exact remaining fils across multiple payment methods", () => {
    const allocations: PaymentAllocation[] = [
      { method: "cash", amountFils: 5_000, tenderedFils: 5_000, changeFils: 0, reference: null },
      { method: "qr", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: null },
    ];

    expect(remainingPaymentFils(15_650, allocations)).toBe(7_150);
  });

  it("adds non-cash allocations without exceeding the remaining balance", () => {
    const first = addPaymentAllocation(15_650, [], "qr", 3_500);
    const second = addPaymentAllocation(15_650, first.allocations, "card", 7_150);

    expect(second.allocations).toEqual([
      { method: "qr", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: null },
      { method: "card", amountFils: 7_150, tenderedFils: 7_150, changeFils: 0, reference: null },
    ]);
    expect(second.remainingFils).toBe(5_000);
  });

  it("rejects a non-cash allocation above the remaining balance", () => {
    const allocations: PaymentAllocation[] = [
      { method: "cash", amountFils: 5_000, tenderedFils: 5_000, changeFils: 0, reference: null },
    ];

    expect(() => addPaymentAllocation(8_500, allocations, "card", 3_501))
      .toThrow(/exceeds the remaining balance of 3500 fils/i);
  });

  it("allows cash over-tender while persisting only the remaining financial allocation", () => {
    const allocations: PaymentAllocation[] = [
      { method: "qr", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: null },
    ];

    const result = addPaymentAllocation(8_500, allocations, "cash", 10_000);

    expect(result.allocation).toEqual({
      method: "cash",
      amountFils: 5_000,
      tenderedFils: 10_000,
      changeFils: 5_000,
      reference: null,
    });
    expect(result.remainingFils).toBe(0);
    expect(result.changeFils).toBe(5_000);
  });

  it("rejects zero, negative, unsafe-integer and post-completion allocations", () => {
    expect(() => addPaymentAllocation(1_000, [], "cash", 0)).toThrow(/positive/i);
    expect(() => addPaymentAllocation(1_000, [], "cash", -1)).toThrow(/positive/i);
    expect(() => addPaymentAllocation(1_000, [], "cash", Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/i);

    const paid: PaymentAllocation[] = [
      { method: "card", amountFils: 1_000, tenderedFils: 1_000, changeFils: 0, reference: null },
    ];
    expect(() => addPaymentAllocation(1_000, paid, "cash", 1_000)).toThrow(/already fully allocated/i);
  });

  it("rejects allocation sets that already exceed the payable total", () => {
    const invalid: PaymentAllocation[] = [
      { method: "card", amountFils: 1_001, tenderedFils: 1_001, changeFils: 0, reference: null },
    ];

    expect(() => remainingPaymentFils(1_000, invalid)).toThrow(/exceed the payable total by 1 fils/i);
  });

  it("converts shared table checkout allocations to exact three-decimal BHD rows", () => {
    const allocations: PaymentAllocation[] = [
      { method: "qr", amountFils: 25, tenderedFils: 25, changeFils: 0, reference: "BP-25" },
      { method: "cash", amountFils: 1_003, tenderedFils: 2_000, changeFils: 997, reference: null },
    ];

    expect(paymentAllocationsToBhdRows(allocations)).toEqual([
      { method: "qr", amount: "0.025", reference: "BP-25" },
      { method: "cash", amount: "1.003", reference: null },
    ]);
  });
});
