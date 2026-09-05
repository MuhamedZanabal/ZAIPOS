import { describe, expect, it } from "vitest";
import { buildCheckoutV2Payload, calculateCartPayableFils } from "./checkoutPayload";

const product = {
  id: "50000000-0000-0000-0000-000000000001",
  name: "Exact BHD Product",
  price: 1.025,
  price_fils: 1025,
  tax_rate: 10,
  product_type: "simple",
};

describe("checkout v2 payload", () => {
  it("calculates the current cart preview in exact integer fils", () => {
    const lines = [{
      id: product.id,
      product,
      quantity: 1,
      discount: 0,
    }] as any;

    expect(calculateCartPayableFils(lines, 0, 0)).toBe(1128);
    expect(calculateCartPayableFils(lines, 0.025, 0.050)).toBe(1153);
  });

  it("handles a cart price that already includes modifier deltas without float drift", () => {
    const lines = [{
      id: `${product.id}:modifier`,
      product: {
        ...product,
        price: 0.1 + 0.2,
        tax_rate: 0,
        _modifiers: [{
          option_id: "70000000-0000-0000-0000-000000000001",
          group_id: "80000000-0000-0000-0000-000000000001",
          name: "Modifier",
          price_delta: 0.2,
        }],
      },
      quantity: 1,
      discount: 0,
    }] as any;

    expect(calculateCartPayableFils(lines, 0, 0)).toBe(300);
  });

  it("never sends client price or tax as authoritative checkout inputs", () => {
    const lines = [{
      id: product.id,
      product,
      quantity: 1,
      discount: 0,
    }] as any;

    const payload = buildCheckoutV2Payload({
      tenantId: "tenant-a",
      branchId: "branch-a",
      cashSessionId: "session-a",
      customerId: "customer-a",
      channel: "pos",
      lines,
      payments: [{ method: "cash", amountFils: 1128, reference: null }],
      discountTotalFils: 0,
      tipAmountFils: 0,
      couponCode: null,
      clientMutationId: "operation-0001",
    });

    expect(payload).toEqual({
      _tenant_id: "tenant-a",
      _branch_id: "branch-a",
      _items: [{
        product_id: product.id,
        quantity: 1,
        discount_fils: 0,
        modifiers: [],
      }],
      _payments: [{ method: "cash", amount_fils: 1128, reference: null }],
      _discount_total_fils: 0,
      _notes: null,
      _customer_id: "customer-a",
      _channel: "pos",
      _tip_amount_fils: 0,
      _coupon_code: null,
      _client_mutation_id: "operation-0001",
      _cash_session_id: "session-a",
    });

    const item = payload._items[0] as Record<string, unknown>;
    expect(item).not.toHaveProperty("unit_price");
    expect(item).not.toHaveProperty("unit_price_fils");
    expect(item).not.toHaveProperty("tax_rate");
  });

  it("rejects payment allocations that do not reconcile with the exact client preview", () => {
    const lines = [{ id: product.id, product, quantity: 1, discount: 0 }] as any;

    expect(() => buildCheckoutV2Payload({
      tenantId: "tenant-a",
      branchId: "branch-a",
      cashSessionId: "session-a",
      customerId: null,
      channel: "pos",
      lines,
      payments: [{ method: "cash", amountFils: 1127, reference: null }],
      discountTotalFils: 0,
      tipAmountFils: 0,
      couponCode: null,
      clientMutationId: "operation-0002",
    })).toThrow(/differ from the payable total by 1 fils/i);
  });
});
