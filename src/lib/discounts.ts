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

/**
 * Split `totalFils` across `bases` proportionally (largest remainder),
 * fils-exact: the result sums to min(totalFils, sum(bases)) and no share
 * exceeds its base.
 */
export function allocateFils(bases: number[], totalFils: number): number[] {
  const sum = bases.reduce((a, b) => a + Math.max(0, b), 0);
  const target = Math.max(0, Math.min(Math.round(totalFils), sum));
  if (target === 0 || sum === 0) return bases.map(() => 0);
  const exact = bases.map((b) => (Math.max(0, b) * target) / sum);
  const shares = exact.map(Math.floor);
  let rest = target - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    if (shares[i] < Math.max(0, bases[i])) { shares[i] += 1; rest -= 1; }
  }
  return shares;
}
