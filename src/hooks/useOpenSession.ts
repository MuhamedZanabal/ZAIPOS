import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** Resolve the current open cash session for the active branch. */
export function useOpenSession(branchId: string | null) {
  return useQuery({
    queryKey: ["open-session", branchId],
    enabled: !!branchId,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data } = await supabase
        .from("cash_sessions")
        .select("id, register_id, user_id, opening_amount, total_cash, total_card, total_transfer, total_qr, total_in, total_out, opened_at")
        .eq("branch_id", branchId!)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });
}
