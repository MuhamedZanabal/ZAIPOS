import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/modules/pos/POS.tsx"), "utf8");

describe("POS native split checkout wiring", () => {
  it("routes checkout through the v2 queue/RPC command boundary", () => {
    expect(source).toContain("POS_CHECKOUT_QUEUE_TYPE");
    expect(source).toContain("POS_CHECKOUT_RPC");
    expect(source).toContain("buildPosCheckoutCommand");
    expect(source).toContain("type: POS_CHECKOUT_QUEUE_TYPE");
    expect(source).toContain("supabase.rpc(POS_CHECKOUT_RPC");
    expect(source).not.toContain("type: 'CHECKOUT_SALE'");
    expect(source).not.toContain('supabase.rpc("checkout_sale", payload)');
  });

  it("accepts the cashier allocation array and binds the exact cash session", () => {
    expect(source).toMatch(/finalize\s*=\s*async\s*\(\s*allocations:\s*PaymentAllocation\[\]/);
    expect(source).toContain("allocations,");
    expect(source).toContain("cashSessionId: openSession?.id ?? null");
  });

  it("prints every persisted payment allocation and opens the drawer for any cash allocation", () => {
    expect(source).toContain("payments: command.receiptPayments");
    expect(source).toContain("if (command.hasCashPayment) await openDrawer()");
  });
});
