import { supabase } from "@/integrations/supabase/client";

export const formatCurrency = (n: number, currency = "COP") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n || 0);

export const todayISO = () => new Date().toISOString().slice(0, 10);

export const formatDate = (d: string | Date) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(d));

export async function getCurrentUserId(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}
