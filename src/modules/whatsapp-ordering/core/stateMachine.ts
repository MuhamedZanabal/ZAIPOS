import type { Actor, OrderStatus } from "./types";

/** Single source of truth for allowed order transitions. Mirrored in SQL (wa_order_transitions). */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["AWAITING_CONFIRMATION", "CANCELLED"],
  AWAITING_CONFIRMATION: ["CONFIRMED", "DRAFT", "CANCELLED"],
  CONFIRMED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["OUT_FOR_DELIVERY", "READY_FOR_PICKUP", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_DELIVERY"],
  READY_FOR_PICKUP: ["PICKED_UP", "CANCELLED"],
  DELIVERED: [], PICKED_UP: [], CANCELLED: [], REJECTED: [], FAILED_DELIVERY: [],
};

export const TERMINAL: OrderStatus[] = ["DELIVERED", "PICKED_UP", "CANCELLED", "REJECTED", "FAILED_DELIVERY"];
export const isTerminal = (s: OrderStatus) => TERMINAL.includes(s);

/** Customers may cancel themselves only before the kitchen starts. */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = ["DRAFT", "AWAITING_CONFIRMATION", "CONFIRMED", "ACCEPTED"];

export class TransitionError extends Error {
  constructor(public from: OrderStatus, public to: OrderStatus, reason = "not allowed") {
    super(`Transition ${from} -> ${to} ${reason}`);
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  if (actor === "customer") {
    if (to === "CANCELLED") return CUSTOMER_CANCELLABLE.includes(from);
    return ["AWAITING_CONFIRMATION", "CONFIRMED", "DRAFT"].includes(to);
  }
  if (to === "READY_FOR_PICKUP" || to === "OUT_FOR_DELIVERY") return true;
  return true;
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: Actor, fulfilment?: string | null) {
  if (!canTransition(from, to, actor)) throw new TransitionError(from, to, `not allowed for ${actor}`);
  if (to === "OUT_FOR_DELIVERY" && fulfilment !== "delivery") throw new TransitionError(from, to, "requires delivery");
  if (to === "READY_FOR_PICKUP" && fulfilment !== "pickup") throw new TransitionError(from, to, "requires pickup");
}
