import { addMoney, subtractMoney } from "@/lib/bahrain";

export type PayMethod = "cash" | "card" | "transfer" | "qr";

export interface PaymentAllocation {
  method: PayMethod;
  /** Financial amount persisted against the sale. */
  amountFils: number;
  /** Amount physically/digitally tendered by the customer. */
  tenderedFils: number;
  /** Cash change returned to the customer. Always zero for non-cash methods. */
  changeFils: number;
  reference: string | null;
}

export interface AddPaymentAllocationResult {
  allocation: PaymentAllocation;
  allocations: PaymentAllocation[];
  remainingFils: number;
  changeFils: number;
}

function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
  return value;
}

function assertNonNegative(value: number, label: string): number {
  const integer = assertSafeInteger(value, label);
  if (integer < 0) throw new RangeError(`${label} must be non-negative`);
  return integer;
}

function assertPositive(value: number, label: string): number {
  const integer = assertSafeInteger(value, label);
  if (integer <= 0) throw new RangeError(`${label} must be positive`);
  return integer;
}

export function remainingPaymentFils(
  payableTotalFils: number,
  allocations: ReadonlyArray<PaymentAllocation>,
): number {
  const payable = assertNonNegative(payableTotalFils, "Payable total (fils)");
  const allocated = addMoney(...allocations.map((allocation) =>
    assertNonNegative(allocation.amountFils, "Payment allocation (fils)"),
  ));

  if (allocated > payable) {
    const excess = subtractMoney(allocated, payable);
    throw new RangeError(`Payment allocations exceed the payable total by ${excess} fils`);
  }

  return subtractMoney(payable, allocated);
}

export function addPaymentAllocation(
  payableTotalFils: number,
  allocations: ReadonlyArray<PaymentAllocation>,
  method: PayMethod,
  tenderedFils: number,
  reference: string | null = null,
): AddPaymentAllocationResult {
  const tendered = assertPositive(tenderedFils, "Tendered amount (fils)");
  const remaining = remainingPaymentFils(payableTotalFils, allocations);

  if (remaining === 0) {
    throw new RangeError("Sale is already fully allocated");
  }

  if (method !== "cash" && tendered > remaining) {
    throw new RangeError(`Payment exceeds the remaining balance of ${remaining} fils`);
  }

  const amountFils = method === "cash" ? Math.min(tendered, remaining) : tendered;
  const changeFils = method === "cash" ? subtractMoney(tendered, amountFils) : 0;

  const allocation: PaymentAllocation = {
    method,
    amountFils,
    tenderedFils: tendered,
    changeFils,
    reference,
  };

  const nextAllocations = [...allocations, allocation];

  return {
    allocation,
    allocations: nextAllocations,
    remainingFils: remainingPaymentFils(payableTotalFils, nextAllocations),
    changeFils,
  };
}
