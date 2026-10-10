import { roundBhd } from "@/lib/bahrain";

/** What table checkout will actually charge: served (dispatched) items only. */
export function servedTotals(items: ReadonlyArray<{ status?: string | null; line_total?: number | string | null }>) {
  let servedTotal = 0;
  let unservedCount = 0;
  for (const item of items) {
    if (item.status === "cancelled") continue;
    if (item.status === "dispatched") servedTotal = roundBhd(servedTotal + Number(item.line_total ?? 0));
    else unservedCount += 1;
  }
  return { servedTotal, unservedCount };
}
