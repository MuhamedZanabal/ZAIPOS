/** Products sold by weight use unit_code "kg"; quantities are kilograms with up to 3 decimals. */
export const WEIGHT_UNIT = "kg";

export function isWeighedProduct(product: { unit_code?: string | null } | null | undefined): boolean {
  return (product?.unit_code ?? "").trim().toLowerCase() === WEIGHT_UNIT;
}

/** Parses "0.75", "0,750" or "1.2". Returns null for empty, zero, negative, >3 decimals or > 999.999 kg. */
export function parseWeightKg(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,3})?$|^\.\d{1,3}$/.test(text)) return null;
  const kg = Number(text);
  return kg > 0 ? Math.round(kg * 1000) / 1000 : null;
}

export function formatQuantity(quantity: number, unitCode?: string | null): string {
  return isWeighedProduct({ unit_code: unitCode }) ? `${quantity.toFixed(3)} kg` : String(quantity);
}
