import { describe, expect, it } from "vitest";
import {
  addFils,
  bhdToFils,
  filsToBhd,
  multiplyFils,
  percentageOfFils,
  subtractFils,
} from "./money";

describe("BHD money kernel", () => {
  it("converts BHD to exact integer fils", () => {
    expect(bhdToFils(1)).toBe(1000);
    expect(bhdToFils(1.234)).toBe(1234);
    expect(bhdToFils("12.650")).toBe(12650);
    expect(bhdToFils(0.001)).toBe(1);
  });

  it("quantizes beyond three decimals using half-away-from-zero semantics", () => {
    expect(bhdToFils(1.2344)).toBe(1234);
    expect(bhdToFils(1.2345)).toBe(1235);
    expect(bhdToFils(-1.2345)).toBe(-1235);
  });

  it("converts fils back without accumulating floating-point drift", () => {
    expect(filsToBhd(12650)).toBe(12.65);
    expect(filsToBhd(1)).toBe(0.001);
  });

  it("adds and subtracts only exact integer fils", () => {
    expect(addFils(100, 200, 350)).toBe(650);
    expect(subtractFils(1000, 333)).toBe(667);
  });

  it("calculates percentages by rounding once to fils", () => {
    expect(percentageOfFils(1000, 10)).toBe(100);
    expect(percentageOfFils(999, 10)).toBe(100);
    expect(percentageOfFils(5, 10)).toBe(1);
  });

  it("multiplies unit fils by quantity and rounds once", () => {
    expect(multiplyFils(1250, 3)).toBe(3750);
    expect(multiplyFils(1250, 0.5)).toBe(625);
  });

  it("rejects non-finite or unsafe monetary values", () => {
    expect(() => bhdToFils(Number.NaN)).toThrow();
    expect(() => bhdToFils(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => bhdToFils("not-money")).toThrow();
    expect(() => addFils(1.5, 2)).toThrow();
  });
});
