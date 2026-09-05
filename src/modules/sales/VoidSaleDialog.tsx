import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useOpenSession } from "@/hooks/useOpenSession";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatFils } from "@/lib/bahrain";
import { AlertTriangle, Ban, Loader2 } from "lucide-react";
import { toast } from "sonner";

type VoidableSale = {
  id: string;
  ticket_number: number;
  total: number;
  total_fils: number;
  status: string;
  channel: string;
  session_id: string | null;
  customer_id?: string | null;
};

interface VoidSaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale: VoidableSale | null;
}

export function VoidSaleDialog({ open, onOpenChange, sale }: VoidSaleDialogProps) {
  const { branchId } = useTenantContext();
  const { data: openSession } = useOpenSession(branchId);
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const operationIdRef = useRef<string | null>(null);

  const resetAttempt = () => {
    operationIdRef.current = null;
  };

  const resetForm = () => {
    setReason("");
    resetAttempt();
  };

  const isInPersonSale = !!sale && (sale.channel === "pos" || sale.channel === "tables");
  const originalSessionOpen = !isInPersonSale
    || (!!sale?.session_id && openSession?.id === sale.session_id);
  const hasUnsupportedCustomerLedger = !!sale?.customer_id;
  const canVoid = !!sale
    && sale.status === "completed"
    && originalSessionOpen
    && !hasUnsupportedCustomerLedger;

  const voidSale = useMutation({
    mutationFn: async () => {
      if (!sale) return;
      if (sale.status !== "completed") {
        throw new Error("Only a completed uncompensated sale can be voided.");
      }
      if (hasUnsupportedCustomerLedger) {
        throw new Error("Customer-linked voids require loyalty reversal evidence. Use the return workflow instead.");
      }
      if (!originalSessionOpen) {
        throw new Error("The original cash session is no longer open. Use the return workflow instead.");
      }

      if (!operationIdRef.current) {
        operationIdRef.current = `void-${crypto.randomUUID()}`;
      }

      const { data, error } = await supabase.rpc("process_sale_void_v2" as any, {
        _sale_id: sale.id,
        _client_mutation_id: operationIdRef.current,
        _cash_session_id: isInPersonSale ? sale.session_id : null,
        _reason: reason.trim() || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Sale voided with compensating payment, stock, and till evidence.");
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["pos-stocks"] });
      qc.invalidateQueries({ queryKey: ["open-session", branchId] });
      onOpenChange(false);
      resetForm();
    },
    onError: (error: any) => {
      toast.error(error?.message ?? "Error voiding sale");
    },
  });

  if (!sale) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) resetForm();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-5 w-5" />
            Void sale — Ticket #{sale.ticket_number}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="rounded-xl border p-3 text-sm">
            <div className="font-semibold">{formatFils(Number(sale.total_fils))}</div>
            <div className="h-meta mt-1">
              A void cancels the entire uncompensated sale. The original sale, items, and payments remain immutable while compensating ledgers reverse their effects.
            </div>
          </div>

          {!originalSessionOpen && (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm g-return-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 g-return-warning-icon" />
              <span>The original cash session is no longer open. Use the return workflow instead.</span>
            </div>
          )}

          {hasUnsupportedCustomerLedger && (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm g-return-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 g-return-warning-icon" />
              <span>Customer-linked voids require loyalty reversal evidence. Use the return workflow instead.</span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="void-reason">Void reason</Label>
            <Input
              id="void-reason"
              aria-label="Void reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                resetAttempt();
              }}
              placeholder="Optional audit note"
            />
          </div>

          <button
            type="button"
            className="g-btn g-btn-primary w-full g-btn-touch"
            disabled={!canVoid || voidSale.isPending}
            onClick={() => voidSale.mutate()}
          >
            {voidSale.isPending
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Voiding…</>
              : "Confirm void"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
