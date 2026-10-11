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
