import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildZReport, zReportLines, type ZSession } from "@/lib/zReport";

/** End-of-day Z-report for one register session, built from the recorded sales, payments, refunds and cash movements. */
export function ZReportDialog({ session, businessName, onClose }: { session: ZSession | null; businessName: string; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["z-report", session?.id],
    enabled: !!session,
    queryFn: async () => {
      const id = session!.id;
      const [sales, returns, movements] = await Promise.all([
        supabase.from("sales").select("id, status, channel, total, tax_total, discount_total").eq("session_id", id),
        supabase.from("sale_returns").select("amount").eq("cash_session_id", id),
        supabase.from("cash_movements").select("type, amount").eq("session_id", id),
      ]);
      for (const result of [sales, returns, movements]) if (result.error) throw new Error(result.error.message);
      const saleIds = (sales.data ?? []).map((s: { id: string }) => s.id);
      const payments = saleIds.length ? await supabase.from("payments").select("sale_id, method, amount").in("sale_id", saleIds) : { data: [], error: null };
      if (payments.error) throw new Error(payments.error.message);
      return zReportLines(buildZReport(session!, sales.data ?? [], payments.data ?? [], returns.data ?? [], movements.data ?? []), businessName);
    },
  });

  return (
    <Dialog open={!!session} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Z-report (end of day)</DialogTitle></DialogHeader>
        {isLoading && <p className="h-meta">Building report…</p>}
        {error && <p role="alert" className="text-sm text-destructive">Could not build the Z-report: {(error as Error).message}</p>}
        {data && (
          <>
            <pre data-testid="z-report" className="z-report-print max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5" dir="ltr">{data.join("\n")}</pre>
            <Button type="button" onClick={() => window.print()}><Printer className="mr-2 h-4 w-4" aria-hidden="true" />Print</Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
