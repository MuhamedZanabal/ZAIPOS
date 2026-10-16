import { describe, expect, it } from "vitest";
import { servedTotals } from "./servedTotals";

describe("servedTotals", () => {
  it("charges served items only and counts the rest", () => {
    expect(servedTotals([
      { status: "dispatched", line_total: 4.95 },
      { status: "ready", line_total: 1.32 },
      { status: "cancelled", line_total: 9 },
    ])).toEqual({ servedTotal: 4.95, unservedCount: 1 });
  });
});
