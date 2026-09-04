import { addFils, assertFils, filsToBhd, subtractFils, type Fils } from "@/lib/money";

export type PayMethod = "cash" | "card" | "transfer" | "qr";

export interface PaymentAllocation {
  method: PayMethod;
  amountFils: Fils;
  reference: string | null;
}

export interface CheckoutPaymentPayload {
  method: PayMethod;
  amount: number;
  reference: string | null;
}

const METHODS = new Set<PayMethod>(["cash", "card", "transfer", "qr"]);

export function assertPaymentAllocation(allocation: PaymentAllocation): PaymentAllocation {
  if (!METHODS.has(allocation.method)) throw new Error("Unsupported payment method");
  assertFils(allocation.amountFils, "payment amount");
  if (allocation.amountFils <= 0) throw new Error("Payment allocation must be greater than zero");
  return allocation;
}

export function allocationTotalFils(allocations: PaymentAllocation[]): Fils {
  return addFils(...allocations.map((allocation) => assertPaymentAllocation(allocation).amountFils));
}

export function remainingPaymentFils(payableFils: Fils, allocations: PaymentAllocation[]): Fils {
  assertFils(payableFils, "payable amount");
  if (payableFils < 0) throw new Error("Payable amount cannot be negative");
  return subtractFils(payableFils, allocationTotalFils(allocations));
}

export function addPaymentAllocation(
  allocations: PaymentAllocation[],
  next: PaymentAllocation,
  payableFils: Fils,
): PaymentAllocation[] {
  assertFils(payableFils, "payable amount");
  assertPaymentAllocation(next);

  const currentTotal = allocationTotalFils(allocations);
  if (addFils(currentTotal, next.amountFils) > payableFils) {
    throw new Error("Payment allocation exceeds the remaining balance");
  }

  const matchingIndex = allocations.findIndex(
    (allocation) => allocation.method === next.method && allocation.reference === next.reference,
  );

  if (matchingIndex < 0) return [...allocations, next];

  return allocations.map((allocation, index) =>
    index === matchingIndex
      ? { ...allocation, amountFils: addFils(allocation.amountFils, next.amountFils) }
      : allocation,
  );
}

export function removePaymentAllocation(allocations: PaymentAllocation[], index: number): PaymentAllocation[] {
  if (!Number.isInteger(index) || index < 0 || index >= allocations.length) return allocations;
  return allocations.filter((_, allocationIndex) => allocationIndex !== index);
}

export function normalizePaymentAllocations(allocations: PaymentAllocation[]): CheckoutPaymentPayload[] {
  return allocations.map((allocation) => {
    assertPaymentAllocation(allocation);
    return {
      method: allocation.method,
      amount: filsToBhd(allocation.amountFils),
      reference: allocation.reference?.trim() || null,
    };
  });
}

export function assertAllocationsSettle(payableFils: Fils, allocations: PaymentAllocation[]): void {
  assertFils(payableFils, "payable amount");
  if (allocationTotalFils(allocations) !== payableFils) {
    throw new Error("Payment allocations must exactly equal the payable total");
  }
}
