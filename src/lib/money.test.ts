import { describe, expect, it } from "vitest";
import * as bahrainModule from "./bahrain";

type MoneyApi = {
  bhdToFils?: (value: string | number) => number;
  filsToBhd?: (value: number) => string;
  formatFils?: (value: number) => string;
  addMoney?: (...values: number[]) => number;
  subtractMoney?: (minuend: number, subtrahend: number) => number;
  percentageOfFils?: (value: number, percentage: string | number) => number;
  roundTo25Fils?: (value: number, direction?: "nearest" | "up" | "down") => number;
  applyVat?: (netFils: number, vatPercentage?: string | number) => {
    netFils: number;
    vatFils: number;
    grossFils: number;
  };
};

const money = bahrainModule as typeof bahrainModule & MoneyApi;

describe("BHD integer-fils money kernel", () => {
  it.each([
    ["0", 0],
    ["0.025", 25],
    ["0.250", 250],
    ["1.000", 1_000],
    ["12.650", 12_650],
    [-1.005, -1_005],
  ])("converts %s BHD to exact integer fils", (bhd, expected) => {
    expect(money.bhdToFils?.(bhd)).toBe(expected);
  });

  it("rejects a sub-fils BHD amount instead of rounding it silently", () => {
    expect(() => money.bhdToFils?.("1.0004")).toThrow(/three decimal places/i);
  });

  it("rejects unsafe integer ranges", () => {
    expect(() => money.bhdToFils?.("9007199254741.000")).toThrow(/safe integer/i);
  });

  it.each([
    [0, "0.000"],
    [25, "0.025"],
    [12_650, "12.650"],
    [-25, "-0.025"],
  ])("converts %i fils to canonical BHD text", (fils, expected) => {
    expect(money.filsToBhd?.(fils)).toBe(expected);
  });

  it("formats fils without changing the three-decimal value", () => {
    const formatted = money.formatFils?.(1_234_567);
    expect(formatted).toContain("BHD");
    expect(formatted).toContain("1,234.567");
  });

  it("adds and subtracts only integer fils", () => {
    expect(money.addMoney?.(5_000, 3_500, 7_150)).toBe(15_650);
    expect(money.subtractMoney?.(15_650, 7_150)).toBe(8_500);
    expect(() => money.addMoney?.(1_000, 0.5)).toThrow(/integer fils/i);
  });

  it("rounds exact percentage results half away from zero", () => {
    expect(money.percentageOfFils?.(335, "10")).toBe(34);
    expect(money.percentageOfFils?.(-335, "10")).toBe(-34);
  });

  it.each([
    [62, "nearest", 50],
    [63, "nearest", 75],
    [51, "down", 50],
    [51, "up", 75],
  ] as const)("rounds %i fils %s to %i", (value, direction, expected) => {
    expect(money.roundTo25Fils?.(value, direction)).toBe(expected);
  });

  it("applies Bahrain VAT entirely in integer fils", () => {
    expect(money.applyVat?.(1_005, "10")).toEqual({
      netFils: 1_005,
      vatFils: 101,
      grossFils: 1_106,
    });
  });
});
