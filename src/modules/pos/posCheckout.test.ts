import { describe, expect, it } from "vitest";
import {
  POS_CHECKOUT_QUEUE_TYPE,
  POS_CHECKOUT_RPC,
  buildPosCheckoutCommand,
} from "./posCheckout";

const line = {
  id: "50000000-0000-0000-0000-000000000001",
  product: {
    id: "50000000-0000-0000-0000-000000000001",
    name: "Bahrain Test Product",
    price: 8.5,
    tax_rate: 0,
    _modifiers: [],
  },
  quantity: 1,
  discount: 0,
} as any;

describe("native v2 POS checkout integration", () => {
  it("uses the v2 offline queue type and RPC", () => {
    expect(POS_CHECKOUT_QUEUE_TYPE).toBe("CHECKOUT_SALE_V2");
    expect(POS_CHECKOUT_RPC).toBe("checkout_sale_v2");
  });

  it("builds a server-authoritative split-payment command without client price or tax", () => {
    const command = buildPosCheckoutCommand({
      tenantId: "10000000-0000-0000-0000-000000000001",
      branchId: "20000000-0000-0000-0000-000000000001",
      cashSessionId: "40000000-0000-0000-0000-000000000001",
      customerId: null,
      channel: "pos",
      lines: [line],
      allocations: [
        { method: "qr", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: "BP-1" },
        { method: "cash", amountFils: 5_000, tenderedFils: 10_000, changeFils: 5_000, reference: null },
      ],
      discountAmountBhd: 0,
      tipAmountBhd: 0,
      couponCode: null,
      clientMutationId: "device-1:operation-1",
    });

    expect(command.queueType).toBe("CHECKOUT_SALE_V2");
    expect(command.rpcName).toBe("checkout_sale_v2");
    expect(command.payload._cash_session_id).toBe("40000000-0000-0000-0000-000000000001");
    expect(command.payload._client_mutation_id).toBe("device-1:operation-1");
    expect(command.payload._payments).toEqual([
      { method: "qr", amount_fils: 3_500, reference: "BP-1" },
      { method: "cash", amount_fils: 5_000, reference: null },
    ]);
    expect(command.payload._items).toEqual([
      {
        product_id: line.product.id,
        quantity: 1,
        discount_fils: 0,
        modifiers: [],
      },
    ]);
    expect(command.payload._items[0]).not.toHaveProperty("unit_price");
    expect(command.payload._items[0]).not.toHaveProperty("unit_price_fils");
    expect(command.payload._items[0]).not.toHaveProperty("tax_rate");
  });

  it("preserves all receipt allocations and opens the drawer whenever any cash allocation exists", () => {
    const command = buildPosCheckoutCommand({
      tenantId: "10000000-0000-0000-0000-000000000001",
      branchId: "20000000-0000-0000-0000-000000000001",
      cashSessionId: "40000000-0000-0000-0000-000000000001",
      customerId: null,
      channel: "pos",
      lines: [line],
      allocations: [
        { method: "card", amountFils: 2_000, tenderedFils: 2_000, changeFils: 0, reference: null },
        { method: "transfer", amountFils: 1_500, tenderedFils: 1_500, changeFils: 0, reference: "BANK-1" },
        { method: "cash", amountFils: 5_000, tenderedFils: 5_000, changeFils: 0, reference: null },
      ],
      discountAmountBhd: 0,
      tipAmountBhd: 0,
      couponCode: null,
      clientMutationId: "device-1:operation-2",
    });

    expect(command.receiptPayments).toEqual([
      { method: "card", amount: 2 },
      { method: "transfer", amount: 1.5 },
      { method: "cash", amount: 5 },
    ]);
    expect(command.hasCashPayment).toBe(true);
  });

  it("does not open the drawer for fully non-cash split payments", () => {
    const command = buildPosCheckoutCommand({
      tenantId: "10000000-0000-0000-0000-000000000001",
      branchId: "20000000-0000-0000-0000-000000000001",
      cashSessionId: "40000000-0000-0000-0000-000000000001",
      customerId: null,
      channel: "pos",
      lines: [line],
      allocations: [
        { method: "qr", amountFils: 3_500, tenderedFils: 3_500, changeFils: 0, reference: null },
        { method: "card", amountFils: 5_000, tenderedFils: 5_000, changeFils: 0, reference: null },
      ],
      discountAmountBhd: 0,
      tipAmountBhd: 0,
      couponCode: null,
      clientMutationId: "device-1:operation-3",
    });

    expect(command.hasCashPayment).toBe(false);
  });
});
