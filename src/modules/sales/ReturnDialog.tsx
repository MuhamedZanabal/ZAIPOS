import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useOpenSession } from "@/hooks/useOpenSession";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from "@/lib/format";
import { Undo2, AlertTriangle, Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";

type SaleItem = {
  id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

type Sale = {
  id: string;
  ticket_number: number;
  total: number;
  created_at: string;
  channel?: string;
  sale_items: SaleItem[];
};

type ReturnReasonCode = "damaged" | "wrong_item" | "quality" | "customer_request" | "other";

type SubmissionAttempt = {
  operationId: string;
  evidencePath: string | null;
};

const REASON_OPTIONS: ReadonlyArray<{ value: ReturnReasonCode; label: string }> = [
  { value: "customer_request", label: "Customer request" },
  { value: "damaged", label: "Damaged product" },
  { value: "wrong_item", label: "Wrong item" },
  { value: "quality", label: "Quality issue" },
  { value: "other", label: "Other" },
];

interface ReturnDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sale: Sale | null;
}

export function ReturnDialog({ open, onOpenChange, sale }: ReturnDialogProps) {
  const { tenantId, branchId } = useTenantContext();
  const { data: openSession } = useOpenSession(branchId);
  const qc = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode>("customer_request");
  const [reason, setReason] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const submissionAttempt = useRef<SubmissionAttempt | null>(null);

  const resetAttempt = () => {
    submissionAttempt.current = null;
  };

  const resetForm = () => {
    setSelectedIds(new Set());
    setReasonCode("customer_request");
    setReason("");
    setEvidenceFile(null);
    resetAttempt();
  };

  const toggle = (id: string) => {
    resetAttempt();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedItems = sale?.sale_items.filter((i) => selectedIds.has(i.id)) ?? [];
  const isInPersonSale = !sale?.channel || sale.channel === "pos" || sale.channel === "tables";
  const hasRequiredSession = !isInPersonSale || !!openSession?.id;

  const processReturn = useMutation({
    mutationFn: async () => {
      if (!sale || !tenantId || !branchId || selectedItems.length === 0) return;
      if (isInPersonSale && !openSession?.id) {
        throw new Error("An open cash session is required to process this return.");
      }

      if (!submissionAttempt.current) {
        const ext = evidenceFile?.name.split(".").pop() || "jpg";
        submissionAttempt.current = {
          operationId: `return-${crypto.randomUUID()}`,
          evidencePath: evidenceFile
            ? `${tenantId}/${sale.id}/${crypto.randomUUID()}.${ext}`
            : null,
        };
      }

      const attempt = submissionAttempt.current;
      let evidenceUrl: string | null = null;
      if (evidenceFile && attempt.evidencePath) {
        const { error: uploadError } = await supabase.storage
          .from("return-evidence")
          .upload(attempt.evidencePath, evidenceFile, { upsert: true });
        if (uploadError) throw uploadError;
        evidenceUrl = attempt.evidencePath;
      }

      const { data, error } = await supabase.rpc("process_sale_return_v2" as any, {
        _sale_id: sale.id,
        _items: selectedItems.map((i) => ({ sale_item_id: i.id, quantity: i.quantity })),
        _reason_code: reasonCode,
        _client_mutation_id: attempt.operationId,
        _cash_session_id: isInPersonSale ? openSession?.id ?? null : null,
        _reason: reason.trim() || null,
        _evidence_url: evidenceUrl,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Return recorded with server-authoritative refund accounting.");
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["pos-stocks"] });
      qc.invalidateQueries({ queryKey: ["open-session", branchId] });
      onOpenChange(false);
      resetForm();
    },
    onError: (e: any) => toast.error(e.message ?? "Error processing return"),
  });

  if (!sale) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) resetForm();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="h-5 w-5 g-return-undo-icon" />
            Return — Ticket #{sale.ticket_number}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <p className="h-meta">Select the products to return:</p>

          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {sale.sale_items.map((item) => (
              <label
                key={item.id}
                className="glass-thin flex items-center gap-3 p-3 rounded-xl cursor-pointer"
              >
                <Checkbox
                  checked={selectedIds.has(item.id)}
                  onCheckedChange={() => toggle(item.id)}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{item.product_name}</div>
                  <div className="h-meta">
                    {item.quantity} × {formatCurrency(Number(item.unit_price))}
                  </div>
                </div>
                <span className="pill pill-ghost tabular-nums">
                  {formatCurrency(Number(item.line_total))}
                </span>
              </label>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="return-reason-code">Reason category</Label>
              <select
                id="return-reason-code"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={reasonCode}
                onChange={(e) => {
                  resetAttempt();
                  setReasonCode(e.target.value as ReturnReasonCode);
                }}
              >
                {REASON_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5" /> Supporting photo
              </Label>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  resetAttempt();
                  setEvidenceFile(e.target.files?.[0] ?? null);
                }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Return notes</Label>
            <Input
              value={reason}
              onChange={(e) => {
                resetAttempt();
                setReason(e.target.value);
              }}
              placeholder="Optional return details"
            />
          </div>

          {!hasRequiredSession && (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm g-return-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 g-return-warning-icon" />
              <span>Open a cash session for this branch before processing an in-person return.</span>
            </div>
          )}

          {selectedItems.length > 0 && (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm g-return-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 g-return-warning-icon" />
              <span>
                Inventory will be restored for <strong>{selectedItems.length}</strong>{" "}
                product(s). The exact refund is calculated by the server from the original sale and payment ledger.
              </span>
            </div>
          )}

          <button
            type="button"
            className="g-btn g-btn-primary w-full g-btn-touch"
            disabled={selectedItems.length === 0 || !hasRequiredSession || processReturn.isPending}
            onClick={() => processReturn.mutate()}
          >
            {processReturn.isPending
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</>
              : "Process return"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
