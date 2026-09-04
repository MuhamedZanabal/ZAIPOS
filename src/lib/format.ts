import { BAHRAIN_CURRENCY, BAHRAIN_LOCALE } from "@/lib/bahrain";

export const formatCurrency = (n: number, currency = BAHRAIN_CURRENCY) => {
  const value = Number(n) || 0;
  const isBhd = currency === BAHRAIN_CURRENCY;

  return new Intl.NumberFormat(BAHRAIN_LOCALE, {
    style: "currency",
    currency,
    ...(isBhd
      ? { minimumFractionDigits: 3, maximumFractionDigits: 3 }
      : {}),
  }).format(value);
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const formatDate = (d: string | Date) =>
  new Intl.DateTimeFormat(BAHRAIN_LOCALE, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(d));

export async function getCurrentUserId(): Promise<string | null> {
  try {
    // Keep pure formatting utilities independent from Supabase initialization.
    const { supabase } = await import("@/integrations/supabase/client");
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}
