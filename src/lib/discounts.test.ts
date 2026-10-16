import { describe, expect, it } from "vitest";
import { discountFils, needsManagerApproval } from "./discounts";

describe("discounts", () => {
  it("computes percent and fixed discounts in fils, clamped to the base", () => {
    expect(discountFils(2500, "percent", 10)).toBe(250);
    expect(discountFils(2500, "percent", 150)).toBe(2500);
    expect(discountFils(2500, "fixed", 0.75)).toBe(750);
    expect(discountFils(2500, "fixed", 9)).toBe(2500);
    expect(discountFils(2500, "percent", -5)).toBe(0);
    expect(discountFils(333, "percent", 50)).toBe(167);
  });
  it("applies the manager approval threshold", () => {
    expect(needsManagerApproval(0, 1000)).toBe(false);
    expect(needsManagerApproval(1, 1000)).toBe(true);
    expect(needsManagerApproval(100, 1000, 10)).toBe(false);
    expect(needsManagerApproval(101, 1000, 10)).toBe(true);
  });
});

import { allocateFils } from "./discounts";
import { linesWithTicketDiscount, ticketDiscountFils, type CartLine } from "@/stores/cart";

describe("allocateFils", () => {
  it("is fils-exact and proportional", () => {
    const shares = allocateFils([1000, 2000, 333], 500);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(500);
    expect(shares).toEqual([150, 300, 50]);
  });
  it("never exceeds a line's base or the total", () => {
    expect(allocateFils([100, 0, 50], 1000)).toEqual([100, 0, 50]);
    expect(allocateFils([], 10)).toEqual([]);
    expect(allocateFils([1, 1, 1], 2).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("whole-ticket discount", () => {
  const line = (id: string, price: number, quantity: number, tax = 10, discount = 0) =>
    ({ id, quantity, discount, product: { id, name: id, price, tax_rate: tax } } as unknown as CartLine);
  it("applies before VAT, spread across lines on their net", () => {
    const lines = [line("a", 1.0, 3), line("b", 0.7, 1, 0, 0.1)];
    expect(ticketDiscountFils(lines, { mode: "percent", value: 10 })).toBe(360);
    const out = linesWithTicketDiscount(lines, { mode: "percent", value: 10 }, "op-1");
    const shares = out.map((l, i) => Math.round(l.discount * 1000) - Math.round(lines[i].discount * 1000));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(360);
    expect(shares).toEqual([300, 60]);
    expect(out.every((l) => l.discountApprovalId === "op-1")).toBe(true);
    // VAT on the discounted net of line a: (3.000 - 0.300) * 10% = 0.270
    expect(Math.round((3000 - Math.round(out[0].discount * 1000)) * 0.1)).toBe(270);
  });
  it("fixed amounts are capped at the ticket net", () => {
    expect(ticketDiscountFils([line("a", 1, 1)], { mode: "fixed", value: 5 })).toBe(1000);
    expect(linesWithTicketDiscount([line("a", 1, 1)], null)[0].discountApprovalId).toBeUndefined();
  });
});
