import { describe, expect, it } from "vitest";
import * as syncQueue from "./syncQueue";

type CheckoutGuard = (type: string) => void;
const checkoutGuard = () => (
  syncQueue as unknown as { assertCheckoutDeviceBoundaryReady?: CheckoutGuard }
).assertCheckoutDeviceBoundaryReady;

describe("credential-less checkout cutover", () => {
  it("refuses both credential-less checkout operation types before submission or queueing", () => {
    const guard = checkoutGuard();
    expect(guard).toBeTypeOf("function");
    if (!guard) return;
    expect(() => guard("CHECKOUT_SALE_V2")).toThrow(/device credential/i);
    expect(() => guard("CHECKOUT_SALE")).toThrow(/device credential/i);
  });

  it("preserves unrelated offline operation types", () => {
    const guard = checkoutGuard();
    expect(guard).toBeTypeOf("function");
    if (!guard) return;
    expect(() => guard("APPLY_INVENTORY_MOVEMENT")).not.toThrow();
  });
});
