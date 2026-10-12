// WhatsApp AI ordering — shared types. Money is always integer fils (1 BHD = 1000 fils).
export type OrderStatus =
  | "DRAFT" | "AWAITING_CONFIRMATION" | "CONFIRMED" | "ACCEPTED" | "PREPARING" | "READY"
  | "OUT_FOR_DELIVERY" | "READY_FOR_PICKUP" | "DELIVERED" | "PICKED_UP"
  | "CANCELLED" | "REJECTED" | "FAILED_DELIVERY";

export type Fulfilment = "delivery" | "pickup";
export type PaymentMethod = "cash_on_delivery" | "benefitpay" | "card_on_delivery";
export type Lang = "en" | "ar";
export type Actor = "customer" | "staff" | "system" | "pos";

export interface CatalogItem {
  productId: string;
  sku?: string;
  nameEn: string;
  nameAr?: string;
  category: string;
  categoryAr?: string;
  priceFils: number; // VAT-exclusive unit price
  taxRatePct: number; // e.g. 10
  available: boolean;
  stock?: number | null; // null/undefined = not stock-tracked
  aliases?: string[];
  modifiers?: { name: string; nameAr?: string; priceFils: number }[];
}

export interface CartLine {
  productId: string;
  qty: number;
  modifiers: string[];
  note?: string;
  unitPriceFils: number; // snapshot at quote time (incl. modifier prices)
  taxRatePct: number;
  nameEn: string;
  nameAr?: string;
}

export interface Order {
  id: string;
  orderNumber: string | null;
  chatId: string;
  branchId: string;
  status: OrderStatus;
  version: number;
  lines: CartLine[];
  fulfilment: Fulfilment | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
  paymentMethod: PaymentMethod | null;
  deliveryFeeFils: number;
  quotedTotalFils: number | null;
  etaMinutes: number | null;
  courierName: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Conversation step inside DRAFT; separate from the order status. */
export type ConvStep = "idle" | "building" | "fulfilment" | "address" | "payment" | "confirm" | "tracking";

export interface Conversation {
  chatId: string;
  lang: Lang;
  step: ConvStep;
  activeOrderId: string | null;
  handoff: boolean; // staff took over; AI paused
  optedOut: boolean;
  lastMenu: { kind: "categories" | "items"; ids: string[] } | null; // what a bare number refers to
  handoffReason: string | null;
  updatedAt: string;
}

export interface InboundMessage {
  messageId: string; // WhatsApp message id; dedupe key
  chatId: string; // remoteJid
  text: string;
  location?: { lat: number; lng: number; address?: string };
  pushName?: string;
  at: string;
}

export interface OutboundMessage { chatId: string; text: string; }

export interface OrderEvent {
  id: string;
  orderId: string;
  type: "order.status_changed";
  from: OrderStatus | null;
  to: OrderStatus;
  version: number;
  actor: Actor;
  at: string;
  order: Order;
  /** idempotency key = orderId:version */
  key: string;
}
