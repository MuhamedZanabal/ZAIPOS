export const BAHRAIN_LOCALE = "en-BH" as const;
export const BAHRAIN_CURRENCY = "BHD" as const;
export const BAHRAIN_STANDARD_VAT = 10 as const;
export const BAHRAIN_COUNTRY_CODE = "+973" as const;
export const BAHRAIN_PHONE_DIGITS = 8 as const;

/** Bahrain cash denominations useful as quick-tender buttons, in BHD. */
export const BHD_CASH_SHORTCUTS = [0.5, 1, 5, 10, 20] as const;

/** Round a monetary value to Bahrain dinar precision (1 BHD = 1000 fils). */
export const roundBhd = (value: number) => Math.round((Number(value) || 0) * 1000) / 1000;

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
