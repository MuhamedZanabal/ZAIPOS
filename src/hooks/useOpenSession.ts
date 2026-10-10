import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * The open register session for the branch. Errors are thrown (not returned
 * as "no session") so that, if the ZAIPOS server is briefly unreachable,
 * React Query keeps the last known session instead of showing the register
 * as closed and blocking offline sales.
 */
export function useOpenSession(branchId: string | null) {
  return useQuery({
    queryKey: ["open-session", branchId],
    enabled: !!branchId,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_sessions")
        .select("id, opening_amount, total_cash, total_card, total_transfer, total_qr, total_in, total_out, opened_at")
        .eq("branch_id", branchId!)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
