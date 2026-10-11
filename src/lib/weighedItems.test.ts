import { describe, expect, it } from "vitest";
import { formatQuantity, isWeighedProduct, parseWeightKg } from "./weighedItems";
import { useCart } from "@/stores/cart";

describe("weighed items", () => {
  it("detects kg products", () => {
    expect(isWeighedProduct({ unit_code: "kg" })).toBe(true);
    expect(isWeighedProduct({ unit_code: "KG " })).toBe(true);
    expect(isWeighedProduct({ unit_code: "unit" })).toBe(false);
    expect(isWeighedProduct(null)).toBe(false);
  });
  it("parses up to 3 decimals", () => {
    expect(parseWeightKg("0.750")).toBe(0.75);
    expect(parseWeightKg("1,2")).toBe(1.2);
    expect(parseWeightKg(".5")).toBe(0.5);
    expect(parseWeightKg("0.0005")).toBeNull();
    expect(parseWeightKg("0")).toBeNull();
    expect(parseWeightKg("-1")).toBeNull();
    expect(parseWeightKg("abc")).toBeNull();
    expect(parseWeightKg("1000")).toBeNull();
  });
  it("formats quantities", () => {
    expect(formatQuantity(0.75, "kg")).toBe("0.750 kg");
    expect(formatQuantity(2, "unit")).toBe("2");
  });
  it("cart adds measured quantities and sums them", () => {
    const product = { id: "tomato", name: "Tomatoes", price: 0.6, tax_rate: 10, unit_code: "kg" } as any;
    useCart.getState().clear();
    useCart.getState().addQuantity(product, 0.75);
    useCart.getState().addQuantity(product, 0.3333);
    const line = useCart.getState().lines[0];
    expect(line.quantity).toBe(1.083);
    useCart.getState().addQuantity(product, 0);
    expect(useCart.getState().lines).toHaveLength(1);
    useCart.getState().clear();
  });
});
