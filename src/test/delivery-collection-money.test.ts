import { describe, expect, it } from "vitest";
import { collectionFils, formatCollectionFils } from "../modules/courier/collectionMoney";
describe("delivery collection amount boundary", () => {
  it("preserves exact fils beyond floating point precision", () => {
    expect(formatCollectionFils(collectionFils("9007199254740993"))).toBe("BHD 9007199254740.993");
    expect(formatCollectionFils(collectionFils("1251"))).toBe("BHD 1.251");
  });
  it("fails visibly for missing, fractional or untrusted numeric values", () => {
    for (const value of [null, undefined, 1251, "1.251", "-1", "1e3", ""]) {
      expect(formatCollectionFils(collectionFils(value))).toBe("Unavailable");
    }
  });
});
