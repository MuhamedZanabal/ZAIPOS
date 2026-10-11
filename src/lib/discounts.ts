/** Percent or fixed (BHD) discounts, computed in integer fils. */
export type DiscountMode = "percent" | "fixed";

export function discountFils(baseFils: number, mode: DiscountMode, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || baseFils <= 0) return 0;
  const raw = mode === "percent" ? Math.round((baseFils * Math.min(value, 100)) / 100) : Math.round(value * 1000);
  return Math.max(0, Math.min(baseFils, raw));
}

/**
 * True when a discount needs a manager. The checkout function currently
 * requires owner/admin/manager for ANY discount, so the default threshold is 0%.
 */
export function needsManagerApproval(discount: number, baseFils: number, thresholdPercent = 0): boolean {
  if (discount <= 0) return false;
  if (baseFils <= 0) return true;
  return (discount / baseFils) * 100 > thresholdPercent;
}
