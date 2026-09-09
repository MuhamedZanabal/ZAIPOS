import { afterEach, describe, expect, it } from "vitest";
import { useCart, type CartProduct } from "./cart";

function product(overrides: Partial<CartProduct> = {}): CartProduct {
  return {
    id: "product-1",
    tenant_id: "tenant-1",
    name: "Café",
    price: 5000,
    tax_rate: 0,
    cost: 0,
    product_type: "simple",
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    barcode: null,
    category_id: null,
    color: null,
    image_url: null,
    min_stock: null,
    sku: null,
    unit_code: null,
    unit_id: null,
    rappi_product_id: null,
    station: null,
    ...overrides,
  };
}

describe("cart store", () => {
  afterEach(() => {
    useCart.getState().clear();
  });

  it("keeps the same product separated when modifier selections differ", () => {
    const base = product();

    useCart.getState().add(base);
    useCart.getState().add({
      ...base,
      price: 6500,
      _modifiers: [{ group_id: "milk", option_id: "almond", name: "Leche almendra", price_delta: 1500 }],
    });
    useCart.getState().add({
      ...base,
      price: 6500,
      _modifiers: [{ group_id: "milk", option_id: "almond", name: "Leche almendra", price_delta: 1500 }],
    });

    const state = useCart.getState();

    expect(state.lines).toHaveLength(2);
    expect(state.lines.find((line) => line.product._modifiers?.length)?.quantity).toBe(2);
    expect(state.total()).toBe(18000);
  });

  it("replaces the current ticket atomically when a held cart is resumed", () => {
    const resumed = [{ id: "resumed", product: product(), quantity: 2, discount: 0 }];
    useCart.getState().add(product({ id: "current" }));

    useCart.getState().replace(resumed);

    expect(useCart.getState().lines).toEqual(resumed);
  });

  it("uses approved fils and clears evidence when quantity exceeds approval", () => {
    useCart.getState().add(product({ price: 1.25 }));
    useCart.getState().setPriceOverride("product-1", {
      requestId: "override-1",
      originalUnitPriceFils: 1250,
      overrideUnitPriceFils: 1000,
      approvedQuantity: 1,
      reason: "Customer price match",
      approvedBy: "manager-1",
      approvedAt: "2026-09-09T00:00:00Z",
    });
    expect(useCart.getState().total()).toBe(1);
    useCart.getState().setQty("product-1", 2);
    expect(useCart.getState().lines[0].priceOverride).toBeUndefined();
    expect(useCart.getState().total()).toBe(2.5);
  });
});
