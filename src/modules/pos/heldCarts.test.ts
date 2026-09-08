import { describe, expect, it } from "vitest";
import type { CartLine, CartProduct } from "@/stores/cart";
import {
  buildHeldCartResumeRequest,
  serializeHeldCartLines,
  type HeldCartResumePreview,
} from "./heldCartModel";

function product(overrides: Partial<CartProduct> = {}): CartProduct {
  return {
    id: "50000000-0000-0000-0000-000000000081",
    tenant_id: "10000000-0000-0000-0000-000000000081",
    name: "Water",
    price: 1.25,
    price_fils: 1250,
    cost: 0.75,
    cost_fils: 750,
    tax_rate: 10,
    product_type: "simple",
    status: "active",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    barcode: null,
    category_id: null,
    color: null,
    description: null,
    image_url: null,
    min_stock: null,
    sku: null,
    sort_order: 0,
    station: null,
    unit_code: null,
    unit_id: null,
    ...overrides,
  } as CartProduct;
}

describe("held cart exact snapshot and resume resolution", () => {
  it("serializes line money as exact integer fils with modifier identity", () => {
    const lines: CartLine[] = [{
      id: "water:ice",
      product: product({
        price: 1.275,
        _modifiers: [{ option_id: "ice", group_id: "temperature", name: "Ice", price_delta: 0.025 }],
      }),
      quantity: 2,
      discount: 0.25,
    }];

    expect(serializeHeldCartLines(lines)).toEqual([{
      line_id: "water:ice",
      product_id: "50000000-0000-0000-0000-000000000081",
      quantity: 2,
      expected_unit_price_fils: 1275,
      discount_fils: 250,
      modifiers: [{ option_id: "ice", group_id: "temperature", name: "Ice", price_delta_fils: 25 }],
    }]);
  });

  it("requires explicit price and stock resolutions before resume", () => {
    const preview: HeldCartResumePreview = {
      cart: { id: "held-1", label: "Lunch order", channel: "pos", customer_id: null, table_id: null },
      items: [{
        line_id: "water",
        product_id: "50000000-0000-0000-0000-000000000081",
        product_name: "Water",
        product_type: "simple",
        quantity: 2,
        expected_unit_price_fils: 1250,
        current_unit_price_fils: 1500,
        discount_fils: 0,
        available_quantity: 1,
        modifiers: [],
        issues: ["price_changed", "insufficient_stock"],
      }],
    };

    expect(buildHeldCartResumeRequest(preview, {})).toEqual({ ready: false, unresolvedLineIds: ["water"], items: [] });
    expect(buildHeldCartResumeRequest(preview, {
      water: { acceptCurrentPrice: true, quantity: 1 },
    })).toEqual({
      ready: true,
      unresolvedLineIds: [],
      items: [{ line_id: "water", accept_current_price: true, quantity: 1, remove: false }],
    });
  });
});
