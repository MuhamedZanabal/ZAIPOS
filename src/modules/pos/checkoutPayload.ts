import type { CartLine } from "@/stores/cart";
import type { SalesChannel } from "@/lib/channels";
import type { PayMethod } from "./paymentAllocations";
import {
  addMoney,
  assertPaymentsReconcileFils,
  bhdToFils,
  percentageOfFils,
  roundBhd,
  subtractMoney,
  type Fils,
} from "@/lib/bahrain";

export interface CheckoutPaymentFils {
  method: PayMethod;
  amountFils: number;
  reference: string | null;
}

export interface CheckoutV2BuildInput {
  tenantId: string;
  branchId: string;
  cashSessionId: string | null;
  customerId: string | null;
  channel: SalesChannel;
  lines: CartLine[];
  payments: CheckoutPaymentFils[];
  discountTotalFils: number;
  tipAmountFils: number;
  couponCode: string | null;
  clientMutationId: string;
  notes?: string | null;
}

export interface CheckoutV2Payload {
  _tenant_id: string;
  _branch_id: string;
  _items: Array<{
    product_id: string;
    quantity: number;
    discount_fils: number;
    modifiers: Array<{
      option_id: string;
      group_id: string;
      name: string;
      price_delta: number;
    }>;
  }>;
  _payments: Array<{
    method: PayMethod;
    amount_fils: number;
    reference: string | null;
  }>;
  _discount_total_fils: number;
  _notes: string | null;
  _customer_id: string | null;
  _channel: SalesChannel;
  _tip_amount_fils: number;
  _coupon_code: string | null;
  _client_mutation_id: string;
  _cash_session_id: string | null;
}

/**
 * Convert a UI BHD number to canonical fils. The UI currently receives Supabase
 * NUMERIC values as JavaScript numbers, so canonicalize to exactly three decimal
 * places before using the strict decimal parser. This value is only a client
 * preview; checkout_sale_v2 independently resolves authoritative price and tax.
 */
function uiBhdToFils(value: number): Fils {
  if (!Number.isFinite(value)) throw new TypeError("BHD value must be finite");
  return bhdToFils(roundBhd(value).toFixed(3));
}

function quantityToMillis(quantity: number): bigint {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError("Cart quantity must be greater than zero");
  }
  const milliunits = Math.round(quantity * 1000);
  if (!Number.isSafeInteger(milliunits)) {
    throw new RangeError("Cart quantity exceeds the supported range");
  }
  if (Math.abs(quantity - milliunits / 1000) > Number.EPSILON * Math.max(1, Math.abs(quantity))) {
    throw new RangeError("Cart quantity supports at most three decimal places");
  }
  return BigInt(milliunits);
}

function multiplyFilsByQuantity(unitPriceFils: number, quantity: number): Fils {
  if (!Number.isSafeInteger(unitPriceFils)) {
    throw new RangeError("Unit price must be an integer number of fils");
  }
  const numerator = BigInt(unitPriceFils) * quantityToMillis(quantity);
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + 500n) / 1000n;
  const result = negative ? -rounded : rounded;
  const numeric = Number(result);
  if (!Number.isSafeInteger(numeric)) {
    throw new RangeError("Line total exceeds the supported range");
  }
  return numeric as Fils;
}

export function calculateCartPayableFils(
  lines: CartLine[],
  orderDiscountBhd: number,
  tipBhd: number,
): Fils {
  const lineTotals = lines.map((line) => {
    const unitPriceFils = uiBhdToFils(Number(line.product.price));
    const grossLineFils = multiplyFilsByQuantity(unitPriceFils, line.quantity);
    const lineDiscountFils = uiBhdToFils(Number(line.discount || 0));
    const netLineFils = subtractMoney(grossLineFils, lineDiscountFils);
    if (netLineFils < 0) throw new RangeError("Line discount cannot exceed the line subtotal");
    const taxFils = percentageOfFils(netLineFils, Number(line.product.tax_rate || 0));
    return addMoney(netLineFils, taxFils);
  });

  const grossFils = addMoney(...lineTotals);
  const orderDiscountFils = uiBhdToFils(orderDiscountBhd);
  const tipFils = uiBhdToFils(tipBhd);
  const afterDiscount = subtractMoney(grossFils, orderDiscountFils);
  if (afterDiscount < 0) throw new RangeError("Order discount cannot exceed the cart total");
  return addMoney(afterDiscount, tipFils);
}

export function buildCheckoutV2Payload(input: CheckoutV2BuildInput): CheckoutV2Payload {
  if (!input.tenantId || !input.branchId) {
    throw new Error("Checkout requires an active business and branch");
  }
  if (input.lines.length === 0) throw new Error("Checkout requires at least one cart line");
  if (!input.clientMutationId.trim()) throw new Error("Checkout requires a stable operation ID");
  if (!Number.isSafeInteger(input.discountTotalFils) || input.discountTotalFils < 0) {
    throw new RangeError("Order discount must be a non-negative integer number of fils");
  }
  if (!Number.isSafeInteger(input.tipAmountFils) || input.tipAmountFils < 0) {
    throw new RangeError("Tip must be a non-negative integer number of fils");
  }

  const previewPayableFils = calculateCartPayableFils(
    input.lines,
    Number(input.discountTotalFils) / 1000,
    Number(input.tipAmountFils) / 1000,
  );
  assertPaymentsReconcileFils(
    previewPayableFils,
    input.payments.map((payment) => ({ amountFils: payment.amountFils })),
  );

  return {
    _tenant_id: input.tenantId,
    _branch_id: input.branchId,
    _items: input.lines.map((line) => ({
      product_id: line.product.id,
      quantity: line.quantity,
      discount_fils: uiBhdToFils(Number(line.discount || 0)),
      modifiers: (line.product._modifiers ?? []).map((modifier) => ({
        option_id: modifier.option_id,
        group_id: modifier.group_id,
        name: modifier.name,
        price_delta: modifier.price_delta,
      })),
    })),
    _payments: input.payments.map((payment) => ({
      method: payment.method,
      amount_fils: payment.amountFils,
      reference: payment.reference,
    })),
    _discount_total_fils: input.discountTotalFils,
    _notes: input.notes ?? null,
    _customer_id: input.customerId,
    _channel: input.channel,
    _tip_amount_fils: input.tipAmountFils,
    _coupon_code: input.couponCode,
    _client_mutation_id: input.clientMutationId,
    _cash_session_id: input.cashSessionId,
  };
}

export function uiMoneyToFils(value: number): Fils {
  return uiBhdToFils(value);
}
