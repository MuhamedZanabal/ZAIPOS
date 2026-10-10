import { describe, expect, it } from "vitest";
import { netOfRefunds } from "./netOfRefunds";

describe("netOfRefunds", () => {
  const sales = [
    { id: "s1", total: 3.465, tax_total: 0.315, created_at: "2026-10-10T10:00:00Z" },
    { id: "s2", total: 3.245, tax_total: 0.295, created_at: "2026-10-10T11:00:00Z" },
    { id: "s3", total: 1.32, tax_total: 0.12, created_at: "2026-10-10T12:00:00Z" },
  ];
  const items = [
    { id: "i1", sale_id: "s1", product_name: "Chicken Machboos", quantity: 1, line_total: 3.025 },
    { id: "i2", sale_id: "s1", product_name: "Karak Tea", quantity: 2, line_total: 0.44 },
    { id: "i3", sale_id: "s2", product_name: "Chicken Machboos", quantity: 1, line_total: 3.025 },
    { id: "i4", sale_id: "s3", product_name: "Umm Ali", quantity: 1, line_total: 1.32 },
  ];

  it("keeps partially refunded sales, net of the refund", () => {
    const r = netOfRefunds(sales, items, [{ sale_item_id: "i2", quantity: 2, amount: 0.44 }]);
    expect(r.sales.map((s) => [s.id, s.total])).toEqual([["s1", 3.025], ["s2", 3.245], ["s3", 1.32]]);
    expect(r.refundTotal).toBe(0.44);
    const machboos = r.products.find((p) => p.name === "Chicken Machboos");
    expect(machboos).toEqual({ name: "Chicken Machboos", qty: 2, total: 6.05 });
    expect(r.products.find((p) => p.name === "Karak Tea")).toBeUndefined();
  });

  it("drops fully refunded sales from tickets and revenue", () => {
    const r = netOfRefunds(sales, items, [{ sale_item_id: "i4", quantity: 1, amount: 1.32 }]);
    expect(r.sales.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(r.refundTotal).toBe(1.32);
  });
});
