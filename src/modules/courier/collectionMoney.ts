/** Read-only presentation of server-provided integer fils; never an RPC amount. */
export function collectionFils(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}
export function formatCollectionFils(value: bigint | null): string {
  if (value === null) return "Unavailable";
  return `BHD ${value / 1000n}.${(value % 1000n).toString().padStart(3, "0")}`;
}
