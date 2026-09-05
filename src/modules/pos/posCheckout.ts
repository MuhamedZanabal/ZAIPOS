import type { CartLine } from "@/stores/cart";
import type { SalesChannel } from "@/lib/channels";
import { filsToBhd } from "@/lib/bahrain";
import { buildCheckoutV2Payload, uiMoneyToFils, type CheckoutV2Payload } from "./checkoutPayload";
import type { PaymentAllocation } from "./paymentAllocations";

export const POS_CHECKOUT_QUEUE_TYPE = "CHECKOUT_SALE_V2" as const;
export const POS_CHECKOUT_RPC = "checkout_sale_v2" as const;

export interface PosCheckoutCommandInput {
  tenantId: string;
  branchId: string;
  cashSessionId: string | null;
  customerId: string | null;
  channel: SalesChannel;
  lines: CartLine[];
  allocations: PaymentAllocation[];
  discountAmountBhd: number;
  tipAmountBhd: number;
  couponCode: string | null;
  clientMutationId: string;
  notes?: string | null;
}

export interface PosCheckoutCommand {
  queueType: typeof POS_CHECKOUT_QUEUE_TYPE;
  rpcName: typeof POS_CHECKOUT_RPC;
  payload: CheckoutV2Payload;
  receiptPayments: Array<{
    method: PaymentAllocation["method"];
    amount: number;
  }>;
  hasCashPayment: boolean;
  changeFils: number;
}

export function buildPosCheckoutCommand(input: PosCheckoutCommandInput): PosCheckoutCommand {
  if (input.allocations.length === 0) {
    throw new Error("Checkout requires at least one payment allocation");
  }

  const payload = buildCheckoutV2Payload({
    tenantId: input.tenantId,
    branchId: input.branchId,
    cashSessionId: input.cashSessionId,
    customerId: input.customerId,
    channel: input.channel,
    lines: input.lines,
    payments: input.allocations.map((allocation) => ({
      method: allocation.method,
      amountFils: allocation.amountFils,
      reference: allocation.reference,
    })),
    discountTotalFils: uiMoneyToFils(input.discountAmountBhd),
    tipAmountFils: uiMoneyToFils(input.tipAmountBhd),
    couponCode: input.couponCode,
    clientMutationId: input.clientMutationId,
    notes: input.notes ?? null,
  });

  return {
    queueType: POS_CHECKOUT_QUEUE_TYPE,
    rpcName: POS_CHECKOUT_RPC,
    payload,
    receiptPayments: input.allocations.map((allocation) => ({
      method: allocation.method,
      amount: Number(filsToBhd(allocation.amountFils)),
    })),
    hasCashPayment: input.allocations.some((allocation) => allocation.method === "cash"),
    changeFils: input.allocations.reduce((total, allocation) => total + allocation.changeFils, 0),
  };
}
