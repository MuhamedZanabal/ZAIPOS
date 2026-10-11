import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { readSetupStatus } from "@/lib/setupWizard";

export const FIRST_SALE_GUIDE_KEY = "zaipos.firstSaleGuide";
export const SETUP_DEFERRED_KEY = "zaipos.setup.deferred";

/** Owners/admins are sent back to the wizard until it's finished (once per session if they defer it). */
export function useSetupInProgress(tenantId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["setup-status", tenantId],
    enabled: !!tenantId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await (supabase as any).from("tenants").select("receipt_config").eq("id", tenantId!).maybeSingle();
      return readSetupStatus(data?.receipt_config)?.status === "in_progress";
    },
  });
}
