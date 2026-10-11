import { describe, expect, it } from "vitest";
import { BUSINESS_MODES, allowsTableService, canAccessPathInMode, capabilityForPath, channelAllowedInMode, hasCapability, normalizeBusinessMode } from "./business-modes";
import { canAccessBusinessMode } from "./roles";

describe("business mode capability map", () => {
  it("knows all four business types and falls back to RETAIL", () => {
    expect(BUSINESS_MODES).toEqual(["RESTAURANT", "CAFE", "SUPERMARKET", "RETAIL"]);
    expect(normalizeBusinessMode("cafe")).toBe("CAFE");
    expect(normalizeBusinessMode(" supermarket ")).toBe("SUPERMARKET");
    expect(normalizeBusinessMode("bakery")).toBe("RETAIL");
    expect(normalizeBusinessMode(null)).toBe("RETAIL");
  });

  it.each(["RESTAURANT", "CAFE"] as const)("%s gets food-service features and no barcode-first till", (mode) => {
    for (const c of ["tables", "waiter", "kds", "recipes", "modifiers", "delivery_platforms", "kitchen_station"] as const) expect(hasCapability(mode, c)).toBe(true);
    expect(hasCapability(mode, "barcode_first")).toBe(false);
    expect(hasCapability(mode, "weighed_items")).toBe(false);
    expect(allowsTableService(mode)).toBe(true);
  });

  it.each(["SUPERMARKET", "RETAIL"] as const)("%s gets barcode, weight, stock, suppliers and no kitchen features", (mode) => {
    for (const c of ["barcode_first", "weighed_items", "suppliers", "inventory"] as const) expect(hasCapability(mode, c)).toBe(true);
    for (const c of ["tables", "waiter", "kds", "recipes", "modifiers", "delivery_platforms", "kitchen_station"] as const) expect(hasCapability(mode, c)).toBe(false);
    expect(allowsTableService(mode)).toBe(false);
  });

  it("maps routes to capabilities", () => {
    expect(capabilityForPath("/tables/123")).toBe("tables");
    expect(capabilityForPath("/kds")).toBe("kds");
    expect(capabilityForPath("/tablesx")).toBeUndefined();
    expect(capabilityForPath("/pos")).toBeUndefined();
  });

  it("guards routes per mode (and keeps the roles.ts entry point)", () => {
    for (const path of ["/tables", "/waiter", "/kds", "/recipes", "/delivery", "/digital-orders", "/courier"]) {
      expect(canAccessPathInMode("SUPERMARKET", path)).toBe(false);
      expect(canAccessBusinessMode("RETAIL", path)).toBe(false);
      expect(canAccessBusinessMode("RESTAURANT", path)).toBe(true);
      expect(canAccessBusinessMode("CAFE", path)).toBe(true);
    }
    for (const path of ["/pos", "/products", "/inventory", "/suppliers", "/reports", "/settings", "/setup"]) {
      for (const mode of BUSINESS_MODES) expect(canAccessBusinessMode(mode, path)).toBe(true);
    }
  });

  it("gates POS sales channels", () => {
    expect(channelAllowedInMode("SUPERMARKET", "talabat")).toBe(false);
    expect(channelAllowedInMode("SUPERMARKET", "tables")).toBe(false);
    expect(channelAllowedInMode("SUPERMARKET", "pos")).toBe(true);
    expect(channelAllowedInMode("CAFE", "tables")).toBe(true);
    expect(channelAllowedInMode("RESTAURANT", "talabat")).toBe(true);
  });
});
