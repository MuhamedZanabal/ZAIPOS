import { filsToBhd, formatFils } from "@/lib/bahrain";
import { uiMoneyToFils } from "./checkoutPayload";
import type { CartLine, CartModifier, CartProduct } from "@/stores/cart";
import type { SalesChannel } from "@/lib/channels";

export type HeldCartIssue =
  | "product_discontinued"
  | "branch_unavailable"
  | "modifier_unavailable"
  | "price_changed"
  | "insufficient_stock";

export interface HeldCartSummary {
  id: string;
  label: string;
  item_count: number;
  total_fils: number;
  channel: SalesChannel;
  customer_name: string | null;
  created_at: string;
  created_by_name: string;
}

export interface HeldCartPreviewItem {
  line_id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  quantity: number;
  expected_unit_price_fils: number;
  current_unit_price_fils: number | null;
  discount_fils: number;
  available_quantity: number | null;
  modifiers: Array<{
    option_id: string;
    group_id: string;
    name: string;
    price_delta_fils: number;
  }>;
  issues: HeldCartIssue[];
  product?: Partial<CartProduct> & { id: string; tenant_id: string; name: string };
}

export interface HeldCartResumePreview {
  cart: {
    id: string;
    label: string;
    channel: SalesChannel;
    customer_id: string | null;
    table_id: string | null;
  };
  items: HeldCartPreviewItem[];
}

export interface HeldCartLineResolution {
  acceptCurrentPrice?: boolean;
  quantity?: number;
  remove?: boolean;
}

export type HeldCartResolutions = Record<string, HeldCartLineResolution>;

export function serializeHeldCartLines(lines: CartLine[]) {
  return lines.map((line) => ({
    line_id: line.id,
    product_id: line.product.id,
    quantity: line.quantity,
    expected_unit_price_fils: uiMoneyToFils(Number(line.product.price)),
    discount_fils: uiMoneyToFils(Number(line.discount || 0)),
    modifiers: (line.product._modifiers ?? []).map((modifier) => ({
      option_id: modifier.option_id,
      group_id: modifier.group_id,
      name: modifier.name,
      price_delta_fils: uiMoneyToFils(Number(modifier.price_delta)),
    })),
  }));
}

export function buildHeldCartResumeRequest(
  preview: HeldCartResumePreview,
  resolutions: HeldCartResolutions,
): {
  ready: boolean;
  unresolvedLineIds: string[];
  items: Array<{
    line_id: string;
    accept_current_price: boolean;
    quantity: number;
    remove: boolean;
  }>;
} {
  const unresolvedLineIds: string[] = [];
  const items = preview.items.map((item) => {
    const resolution = resolutions[item.line_id] ?? {};
    if (resolution.remove) {
      return {
        line_id: item.line_id,
        accept_current_price: false,
        quantity: item.quantity,
        remove: true,
      };
    }

    const mustRemove = item.issues.some((issue) =>
      issue === "product_discontinued" ||
      issue === "branch_unavailable" ||
      issue === "modifier_unavailable"
    );
    const priceResolved = !item.issues.includes("price_changed") || resolution.acceptCurrentPrice === true;
    const requestedQuantity = resolution.quantity ?? item.quantity;
    const stockResolved = !item.issues.includes("insufficient_stock") || (
      item.available_quantity !== null &&
      requestedQuantity > 0 &&
      requestedQuantity <= item.available_quantity &&
      requestedQuantity <= item.quantity
    );

    if (mustRemove || !priceResolved || !stockResolved) unresolvedLineIds.push(item.line_id);

    return {
      line_id: item.line_id,
      accept_current_price: resolution.acceptCurrentPrice === true,
      quantity: requestedQuantity,
      remove: false,
    };
  });

  return {
    ready: unresolvedLineIds.length === 0,
    unresolvedLineIds,
    items: unresolvedLineIds.length === 0 ? items : [],
  };
}

export function buildResumedCartLines(result: HeldCartResumePreview): CartLine[] {
  return result.items.map((item) => {
    if (!item.product || item.current_unit_price_fils === null) {
      throw new TypeError(`Held cart item ${item.line_id} is missing current product data`);
    }
    const modifiers: CartModifier[] = item.modifiers.map((modifier) => ({
      option_id: modifier.option_id,
      group_id: modifier.group_id,
      name: modifier.name,
      price_delta: Number(filsToBhd(modifier.price_delta_fils)),
    }));
    const product = {
      barcode: null,
      category_id: null,
      color: null,
      cost: 0,
      cost_fils: 0,
      created_at: new Date(0).toISOString(),
      description: null,
      image_url: null,
      min_stock: null,
      price_fils: item.current_unit_price_fils,
      product_type: item.product_type,
      sku: null,
      sort_order: 0,
      station: null,
      status: "active",
      tax_rate: 0,
      unit_code: null,
      unit_id: null,
      updated_at: new Date().toISOString(),
      ...item.product,
      price: Number(filsToBhd(item.current_unit_price_fils)),
      _modifiers: modifiers,
    } as CartProduct;

    return {
      id: item.line_id,
      product,
      quantity: Number(item.quantity),
      discount: Number(filsToBhd(item.discount_fils)),
    };
  });
}

export function heldCartIssueLabel(issue: HeldCartIssue): string {
  if (issue === "product_discontinued") return "Product discontinued";
  if (issue === "branch_unavailable") return "Unavailable at this branch";
  if (issue === "modifier_unavailable") return "Modifier unavailable";
  if (issue === "price_changed") return "Price changed";
  return "Insufficient stock";
}

export function heldCartPriceChange(item: HeldCartPreviewItem): string {
  return `${formatFils(item.expected_unit_price_fils)} → ${
    item.current_unit_price_fils === null ? "Unavailable" : formatFils(item.current_unit_price_fils)
  }`;
}
