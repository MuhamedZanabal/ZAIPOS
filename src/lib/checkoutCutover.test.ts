import { describe, expect, it } from "vitest";
import * as syncQueue from "./syncQueue";

type CheckoutGuard = (type: string) => void;
const checkoutGuard = () => (
  syncQueue as unknown as { assertCheckoutDeviceBoundaryReady?: CheckoutGuard }
).assertCheckoutDeviceBoundaryReady;

describe("credential-less financial primitive cutover", () => {
  it("refuses legacy sale, restaurant checkout and non-atomic financial writes before submission or queueing", () => {
    const guard = checkoutGuard();
    expect(guard).toBeTypeOf("function");
    if (!guard) return;
    expect(() => guard("CHECKOUT_SALE_V2")).toThrow(/device credential/i);
    expect(() => guard("CHECKOUT_SALE")).toThrow(/device credential/i);
    expect(() => guard("CHECKOUT_TABLE_ORDER")).toThrow(/device credential/i);
    expect(() => guard("APPLY_INVENTORY_MOVEMENT")).toThrow(/device credential/i);
    expect(() => guard("ADD_TABLE_ORDER_ITEMS")).toThrow(/device credential/i);
  });

  it("preserves supported nonfinancial kitchen queue operations", () => {
    const guard = checkoutGuard();
    expect(guard).toBeTypeOf("function");
    if (!guard) return;
    expect(() => guard("SEND_TO_KITCHEN")).not.toThrow();
  });
});
