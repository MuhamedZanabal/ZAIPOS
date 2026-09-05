import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useOpenSession } from "@/hooks/useOpenSession";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from "@/lib/format";
import { bhdToFils, formatFils } from "@/lib/bahrain";
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
  total_fils?: number;
  tip_amount_fils?: number;
  status?: string;
  customer_id?: string | null;
  created_at: string;
  channel?: string;
  sale_items: SaleItem[];
};

type ReturnReasonCode = "damaged" | "wrong_item" | "quality" | "customer_request" | "other";

type SubmissionAttempt = {
  operationId: string;
  evidencePath: string | null;
};

type ReturnLedger = {
  returnedFils: number;
  returnedQuantityBySaleItem: Record<string, number>;
};

const REASON_OPTIONS: ReadonlyArray<{ value: ReturnReasonCode; label: string }> = [
  { value: "customer_request", label: "Customer request" },
  { value: "damaged", label: "Damaged product" },
  { value: "wrong_item", label: "Wrong item" },
  { value: "quality", label: "Quality issue" },
  { value: "other", label: "Other" },
];

const roundQuantity = (quantity: number) => Math.round(quantity * 1_000) / 1_000;
const formatQuantity = (quantity: number) => roundQuantity(quantity).toFixed(3);

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
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode>("customer_request");
  const [reason, setReason] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const submissionAttempt = useRef<SubmissionAttempt | null>(null);

  const returnLedger = useQuery<ReturnLedger>({
    queryKey: ["sale-return-ledger", sale?.id],
    enabled: open && !!sale?.id,
    queryFn: async () => {
      if (!sale) return { returnedFils: 0, returnedQuantityBySaleItem: {} };

      const [returnsResult, itemsResult] = await Promise.all([
        (supabase as any)
          .from("sale_returns")
          .select("amount_fils")
          .eq("original_sale_id", sale.id)
          .eq("status", "completed"),
        (supabase as any)
          .from("sale_return_items")
          .select("sale_item_id, quantity, amount_fils, sale_returns!inner(original_sale_id, status)")
          .eq("sale_returns.original_sale_id", sale.id)
          .eq("sale_returns.status", "completed"),
      ]);

      if (returnsResult.error) throw returnsResult.error;
      if (itemsResult.error) throw itemsResult.error;

      const returnedFils = (returnsResult.data ?? []).reduce(
        (sum: number, row: { amount_fils: number | string }) => sum + Number(row.amount_fils),
        0,
      );
      const returnedQuantityBySaleItem = (itemsResult.data ?? []).reduce(
        (totals: Record<string, number>, row: { sale_item_id: string; quantity: number | string }) => {
          totals[row.sale_item_id] = roundQuantity(
            (totals[row.sale_item_id] ?? 0) + Number(row.quantity),
          );
          return totals;
        },
        {},
      );

      return { returnedFils, returnedQuantityBySaleItem };
    },
  });

  const resetAttempt = () => {
    submissionAttempt.current = null;
  };

  const resetForm = () => {
    setSelectedIds(new Set());
    setReturnQuantities({});
    setReasonCode("customer_request");
    setReason("");
    setEvidenceFile(null);
    resetAttempt();
  };

  const remainingQuantity = (item: SaleItem) => roundQuantity(Math.max(
    0,
    Number(item.quantity) - (returnLedger.data?.returnedQuantityBySaleItem[item.id] ?? 0),
  ));

  const hasUnsupportedCustomerLedger = !!sale?.customer_id;

  const toggle = (item: SaleItem) => {
    resetAttempt();
    if (hasUnsupportedCustomerLedger) return;
    const available = remainingQuantity(item);
    if (available <= 0) return;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
        setReturnQuantities((quantities) => {
          const updated = { ...quantities };
          delete updated[item.id];
          return updated;
        });
      } else {
        next.add(item.id);
        setReturnQuantities((quantities) => ({ ...quantities, [item.id]: available }));
      }
      return next;
    });
  };

  const selectedItems = sale?.sale_items
    .filter((item) => selectedIds.has(item.id))
    .map((item) => ({ item, quantity: returnQuantities[item.id] ?? 0 })) ?? [];
  const isInPersonSale = !sale?.channel || sale.channel === "pos" || sale.channel === "tables";
  const hasRequiredSession = !isInPersonSale || !!openSession?.id;
  const requiresLoadedLedger = sale?.status === "partially_refunded";
  const ledgerReady = !requiresLoadedLedger || returnLedger.isSuccess;

  const saleTotalFils = sale
    ? (Number.isSafeInteger(sale.total_fils) ? Number(sale.total_fils) : Number(bhdToFils(sale.total)))
    : 0;
  const tipFils = sale && Number.isSafeInteger(sale.tip_amount_fils)
    ? Number(sale.tip_amount_fils)
    : 0;
  const merchandisePoolFils = Math.max(0, saleTotalFils - tipFils);
  const remainingRefundableFils = Math.max(
    0,
    merchandisePoolFils - (returnLedger.data?.returnedFils ?? 0),
  );

  const processReturn = useMutation({
    mutationFn: async () => {
      if (!sale || !tenantId || !branchId || selectedItems.length === 0) return;
      if (hasUnsupportedCustomerLedger) {
        throw new Error("Customer-linked returns require exact loyalty reversal evidence before they can be processed.");
      }
      if (!ledgerReady) throw new Error("Return history is still loading. Try again after it is verified.");
      if (returnLedger.error) throw new Error("Return history could not be verified. The return was not submitted.");
      if (isInPersonSale && !openSession?.id) {
        throw new Error("An open cash session is required to process this return.");
      }

      for (const { item, quantity } of selectedItems) {
        const available = remainingQuantity(item);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > available) {
          throw new Error(`Return quantity for ${item.product_name} exceeds the verified remaining quantity.`);
        }
        if (Math.abs(quantity * 1_000 - Math.round(quantity * 1_000)) > 1e-9) {
          throw new Error(`Return quantity for ${item.product_name} must use at most three decimal places.`);
        }
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
        _items: selectedItems.map(({ item, quantity }) => ({
          sale_item_id: item.id,
          quantity,
        })),
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
      qc.invalidateQueries({ queryKey: ["sale-return-ledger", sale?.id] });
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
          <div className="flex items-center justify-between gap-3">
            <p className="h-meta">Select the products to return:</p>
            <span className="pill pill-ghost tabular-nums">
              {formatFils(remainingRefundableFils)} remaining refundable
            </span>
          </div>

          {hasUnsupportedCustomerLedger && (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm g-return-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 g-return-warning-icon" />
              <span>Customer-linked returns require exact loyalty reversal evidence before they can be processed.</span>
            </div>
          )}

          {returnLedger.isError && (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm g-return-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 g-return-warning-icon" />
              <span>Return history could not be verified. No return will be submitted.</span>
            </div>
          )}

          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {sale.sale_items.map((item) => {
              const available = remainingQuantity(item);
              const selected = selectedIds.has(item.id);
              return (
                <div
                  key={item.id}
                  className="glass-thin flex items-center gap-3 p-3 rounded-xl"
                >
                  <Checkbox
                    checked={selected}
                    disabled={
                      hasUnsupportedCustomerLedger
                      || available <= 0
                      || (requiresLoadedLedger && !returnLedger.isSuccess)
                    }
                    onCheckedChange={() => toggle(item)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{item.product_name}</div>
                    <div className="h-meta">
                      {formatQuantity(available)} remaining · {formatCurrency(Number(item.unit_price))} original unit price
                    </div>
                    {selected && (
                      <div className="mt-2 max-w-40 space-y-1">
                        <Label htmlFor={`return-quantity-${item.id}`} className="text-xs">Return quantity</Label>
                        <Input
                          id={`return-quantity-${item.id}`}
                          aria-label={`Return quantity for ${item.product_name}`}
                          type="number"
                          inputMode="decimal"
                          min="0.001"
                          max={available}
                          step="0.001"
                          value={returnQuantities[item.id] ?? available}
                          onChange={(e) => {
                            resetAttempt();
                            setReturnQuantities((quantities) => ({
                              ...quantities,
                              [item.id]: Number(e.target.value),
                            }));
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
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
            disabled={
              hasUnsupportedCustomerLedger
              || selectedItems.length === 0
              || !hasRequiredSession
              || !ledgerReady
              || returnLedger.isError
              || processReturn.isPending
            }
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
