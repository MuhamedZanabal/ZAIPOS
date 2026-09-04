export type SalesChannel = "pos" | "tables" | "talabat" | "whatsapp" | "delivery";

export const CHANNELS: { id: SalesChannel; label: string; short: string }[] = [
  { id: "pos", label: "In-person", short: "POS" },
  { id: "tables", label: "Tables / Orders", short: "Tables" },
  { id: "talabat", label: "Talabat", short: "Talabat" },
  { id: "whatsapp", label: "WhatsApp", short: "WA" },
  { id: "delivery", label: "In-house Delivery", short: "Delivery" },
];

export const BAHRAIN_CHANNEL_IDS = CHANNELS.map((channel) => channel.id);

/**
 * Convert inherited LatAm channel values to the Bahrain-native channel model.
 * This is a compatibility boundary only: the UI never exposes Rappi, Didi, or Uber.
 */
export function normalizeBahrainChannels(values: readonly string[] | null | undefined): SalesChannel[] {
  const result = new Set<SalesChannel>();

  for (const raw of values ?? []) {
    const value = raw.toLowerCase();
    if (value === "rappi" || value === "didi" || value === "uber") {
      result.add("talabat");
      continue;
    }
    if (value === "qr") {
      // Legacy QR ordering channel is not a Bahrain delivery channel.
      continue;
    }
    if (BAHRAIN_CHANNEL_IDS.includes(value as SalesChannel)) {
      result.add(value as SalesChannel);
    }
  }

  if (result.size === 0) {
    return ["pos", "tables", "talabat", "whatsapp", "delivery"];
  }

  return BAHRAIN_CHANNEL_IDS.filter((channel) => result.has(channel));
}

export const channelLabel = (channel: string) => {
  if (channel === "rappi" || channel === "didi" || channel === "uber") return "Talabat";
  return CHANNELS.find((item) => item.id === channel)?.label ?? channel;
};

export type ChannelPriceRow = {
  product_id: string;
  branch_id: string | null;
  channel: string;
  price: number;
};

export type BranchProductRow = {
  product_id: string;
  branch_id: string;
  is_available: boolean;
  local_price: number | null;
};

/**
 * Resolve final unit price for a product given branch + channel.
 * Priority:
 *   1. branch+channel specific price
 *   2. global channel price (branch_id NULL)
 *   3. branch local price override (branch_products.local_price)
 *   4. base product.price
 */
export function resolvePrice(
  productId: string,
  basePrice: number,
  branchId: string | null,
  channel: SalesChannel,
  channelPrices: ChannelPriceRow[],
  branchProducts: BranchProductRow[]
): number {
  if (branchId) {
    const branchChannel = channelPrices.find(
      (price) => price.product_id === productId && price.branch_id === branchId && price.channel === channel
    );
    if (branchChannel) return Number(branchChannel.price);
  }

  const globalChannel = channelPrices.find(
    (price) => price.product_id === productId && price.branch_id === null && price.channel === channel
  );
  if (globalChannel) return Number(globalChannel.price);

  if (branchId) {
    const branchProduct = branchProducts.find(
      (product) => product.product_id === productId && product.branch_id === branchId
    );
    if (branchProduct?.local_price != null) return Number(branchProduct.local_price);
  }

  return Number(basePrice);
}
