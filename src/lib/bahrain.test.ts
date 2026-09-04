import { describe, expect, it } from "vitest";
import {
  BAHRAIN_CURRENCY,
  BAHRAIN_COUNTRY_CODE,
  BAHRAIN_LOCALE,
  BAHRAIN_STANDARD_VAT,
  isBahrainPhone,
  normalizeBahrainPhone,
  roundBhd,
} from "./bahrain";
import { formatCurrency } from "./format";

describe("Bahrain defaults", () => {
  it("uses Bahrain locale, BHD, +973, and 10% VAT", () => {
    expect(BAHRAIN_LOCALE).toBe("en-BH");
    expect(BAHRAIN_CURRENCY).toBe("BHD");
    expect(BAHRAIN_COUNTRY_CODE).toBe("+973");
    expect(BAHRAIN_STANDARD_VAT).toBe(10);
  });

  it("normalizes Bahrain subscriber numbers to E.164", () => {
    expect(normalizeBahrainPhone("36001234")).toBe("+97336001234");
    expect(normalizeBahrainPhone("+973 3600 1234")).toBe("+97336001234");
    expect(isBahrainPhone("36001234")).toBe(true);
  });

  it("does not guess non-Bahrain numbers", () => {
    expect(normalizeBahrainPhone("12345")).toBe("12345");
    expect(isBahrainPhone("12345")).toBe(false);
  });

  it("rounds and displays BHD to three decimal places", () => {
    expect(roundBhd(1.23456)).toBe(1.235);
    expect(formatCurrency(1.5)).toContain("1.500");
  });
});
