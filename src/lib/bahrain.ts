export const BAHRAIN_LOCALE = "en-BH" as const;
export const BAHRAIN_CURRENCY = "BHD" as const;
export const BAHRAIN_STANDARD_VAT = 10 as const;
export const BAHRAIN_COUNTRY_CODE = "+973" as const;
export const BAHRAIN_PHONE_DIGITS = 8 as const;
export const FILS_PER_BHD = 1_000 as const;

/** Bahrain cash denominations useful as quick-tender buttons, in BHD. */
export const BHD_CASH_SHORTCUTS = [0.5, 1, 5, 10, 20] as const;

/** Round a monetary value to Bahrain dinar precision (1 BHD = 1000 fils). */
export const roundBhd = (value: number) => Math.round((Number(value) || 0) * 1000) / 1000;

export type Fils = number & { readonly __fils: unique symbol };
export type MoneyRoundingDirection = "nearest" | "up" | "down";

function exactSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
  return value;
}

function decimalText(value: string | number, label: string): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }

  const text = String(value).trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    throw new TypeError(`${label} must be a plain decimal number`);
  }
  return text;
}

function decimalToScaledInteger(
  value: string | number,
  fractionDigits: number,
  label: string,
): bigint {
  const text = decimalText(value, label);
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [whole, rawFraction = ""] = unsigned.split(".");
  const fraction = rawFraction.replace(/0+$/, "");

  if (fraction.length > fractionDigits) {
    const precision = fractionDigits === 3 ? "three" : String(fractionDigits);
    throw new RangeError(`${label} supports at most ${precision} decimal places`);
  }

  const scale = 10n ** BigInt(fractionDigits);
  const scaled = BigInt(whole) * scale + BigInt(fraction.padEnd(fractionDigits, "0") || "0");
  return negative ? -scaled : scaled;
}

function bigintToSafeInteger(value: bigint, label: string): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const min = BigInt(Number.MIN_SAFE_INTEGER);
  if (value > max || value < min) {
    throw new RangeError(`${label} exceeds the JavaScript safe integer range`);
  }
  return Number(value);
}

/** Convert canonical BHD decimal input to exact integer fils without float arithmetic. */
export function bhdToFils(value: string | number): Fils {
  const scaled = decimalToScaledInteger(value, 3, "BHD amount");
  return bigintToSafeInteger(scaled, "BHD amount in fils") as Fils;
}

/** Convert exact integer fils to canonical BHD text with three decimal places. */
export function filsToBhd(value: number): string {
  const fils = exactSafeInteger(value, "Fils amount");
  const negative = fils < 0;
  const absolute = Math.abs(fils);
  const whole = Math.floor(absolute / FILS_PER_BHD);
  const fraction = String(absolute % FILS_PER_BHD).padStart(3, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Format integer fils for display while retaining the exact three-decimal value. */
export function formatFils(value: number): string {
  const canonical = filsToBhd(value);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole, fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${BAHRAIN_CURRENCY} ${negative ? "-" : ""}${grouped}.${fraction}`;
}

/** Add integer-fils values with overflow validation. */
export function addMoney(...values: number[]): Fils {
  const total = values.reduce(
    (sum, value) => sum + BigInt(exactSafeInteger(value, "Money operand (integer fils)")),
    0n,
  );
  return bigintToSafeInteger(total, "Money total") as Fils;
}

/** Subtract integer-fils values with overflow validation. */
export function subtractMoney(minuend: number, subtrahend: number): Fils {
  return addMoney(minuend, -exactSafeInteger(subtrahend, "Money operand (integer fils)"));
}

function roundRatioHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

/** Calculate a percentage of integer fils using six-decimal percentage precision. */
export function percentageOfFils(value: number, percentage: string | number): Fils {
  const fils = exactSafeInteger(value, "Money amount (integer fils)");
  const percentageScale = 1_000_000n;
  const scaledPercentage = decimalToScaledInteger(percentage, 6, "Percentage");
  const result = roundRatioHalfAwayFromZero(
    BigInt(fils) * scaledPercentage,
    100n * percentageScale,
  );
  return bigintToSafeInteger(result, "Percentage result") as Fils;
}

/** Round a non-negative fils amount to a 25-fils pricing increment. */
export function roundTo25Fils(
  value: number,
  direction: MoneyRoundingDirection = "nearest",
): Fils {
  const fils = exactSafeInteger(value, "Money amount (integer fils)");
  if (fils < 0) throw new RangeError("Money amount must be non-negative for price rounding");

  const remainder = fils % 25;
  if (remainder === 0) return fils as Fils;
  if (direction === "down") return (fils - remainder) as Fils;
  if (direction === "up") return (fils + 25 - remainder) as Fils;
  return (remainder <= 12 ? fils - remainder : fils + 25 - remainder) as Fils;
}

/** Apply VAT to a net integer-fils amount and return a fully reconciled breakdown. */
export function applyVat(
  netFils: number,
  vatPercentage: string | number = BAHRAIN_STANDARD_VAT,
): { netFils: Fils; vatFils: Fils; grossFils: Fils } {
  const net = exactSafeInteger(netFils, "Net amount (integer fils)") as Fils;
  if (decimalToScaledInteger(vatPercentage, 6, "VAT percentage") < 0n) {
    throw new RangeError("VAT percentage must be non-negative");
  }
  const vat = percentageOfFils(net, vatPercentage);
  return { netFils: net, vatFils: vat, grossFils: addMoney(net, vat) };
}

export interface PaymentAllocationFils {
  amountFils: number;
}

export function sumPaymentAllocationsFils(
  payments: ReadonlyArray<PaymentAllocationFils>,
): Fils {
  return addMoney(...payments.map((payment) => {
    const amount = exactSafeInteger(payment.amountFils, "Payment allocation (integer fils)");
    if (amount < 0) throw new RangeError("Payment allocation must be non-negative");
    return amount;
  }));
}

export function assertPaymentsReconcileFils(
  payableTotalFils: number,
  payments: ReadonlyArray<PaymentAllocationFils>,
): Fils {
  const payable = exactSafeInteger(payableTotalFils, "Payable total (integer fils)");
  const allocated = sumPaymentAllocationsFils(payments);
  const difference = Math.abs(subtractMoney(allocated, payable));
  if (difference !== 0) {
    throw new RangeError(`Payment allocations differ from the payable total by ${difference} fils`);
  }
  return allocated;
}

export interface TillCashInputsFils {
  openingCashFils: number;
  cashSalesFils: number;
  cashInFils: number;
  cashRefundsFils: number;
  cashOutFils: number;
}

export function expectedTillCashFils(input: TillCashInputsFils): Fils {
  return subtractMoney(
    subtractMoney(
      addMoney(input.openingCashFils, input.cashSalesFils, input.cashInFils),
      input.cashRefundsFils,
    ),
    input.cashOutFils,
  );
}

export function remainingRefundableFils(
  saleTotalFils: number,
  alreadyRefundedFils: number,
): Fils {
  return subtractMoney(saleTotalFils, alreadyRefundedFils);
}

export function assertRefundAllowedFils(
  saleTotalFils: number,
  alreadyRefundedFils: number,
  requestedRefundFils: number,
): Fils {
  const requested = exactSafeInteger(requestedRefundFils, "Requested refund (integer fils)") as Fils;
  if (requested <= 0) throw new RangeError("Requested refund must be positive");
  const remaining = remainingRefundableFils(saleTotalFils, alreadyRefundedFils);
  if (requested > remaining) {
    throw new RangeError(`Requested refund exceeds the remaining refundable value of BHD ${filsToBhd(remaining)}`);
  }
  return requested;
}

/**
 * Normalize a Bahrain subscriber number to E.164 when it is unambiguous.
 * Unknown/non-Bahrain formats are returned trimmed instead of being guessed.
 */
export function normalizeBahrainPhone(input: string): string {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");

  if (digits.length === BAHRAIN_PHONE_DIGITS) {
    return `${BAHRAIN_COUNTRY_CODE}${digits}`;
  }

  if (digits.length === BAHRAIN_PHONE_DIGITS + 3 && digits.startsWith("973")) {
    return `+${digits}`;
  }

  return raw;
}

export function isBahrainPhone(input: string): boolean {
  return /^\+973\d{8}$/.test(normalizeBahrainPhone(input));
}
