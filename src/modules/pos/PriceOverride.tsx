import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { bhdToFils, filsToBhd, formatFils } from "@/lib/bahrain";
import type { SalesChannel } from "@/lib/channels";
import { effectiveCartUnitPrice, type CartLine, type PriceOverrideEvidence } from "@/stores/cart";
import { toast } from "sonner";

type OverrideRequest = {
  id: string;
  status: "pending" | "approved" | "rejected" | "consumed" | "expired";
  quantity?: number | string;
  original_unit_price_fils?: number;
  requested_unit_price_fils?: number;
  request_reason?: string;
  approved_by?: string | null;
  approved_at?: string | null;
  product_name?: string;
  requested_by?: string;
  created_at?: string;
};

function operationId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function callRpc(name: string, payload: Record<string, unknown>) {
  const { data, error } = await (supabase.rpc as any)(name, payload);
  if (error) throw error;
  return data;
}

interface PriceOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  branchId: string;
  channel: SalesChannel;
  line: CartLine;
  onApproved: (evidence: PriceOverrideEvidence) => void;
}

export function PriceOverrideDialog({ open, onOpenChange, tenantId, branchId, channel, line, onApproved }: PriceOverrideDialogProps) {
  const currentFils = Math.round(effectiveCartUnitPrice(line) * 1000);
  const [price, setPrice] = useState(filsToBhd(currentFils));
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<OverrideRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const requestOperation = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrice(filsToBhd(Math.round(effectiveCartUnitPrice(line) * 1000)));
    setReason("");
    setRequest(null);
    requestOperation.current = null;
  }, [open, line.id]);

  const refresh = useCallback(async (requestId: string) => {
    const next = await callRpc("get_price_override_request_v1", { _request_id: requestId });
    setRequest(next as OverrideRequest);
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const requestedFils = bhdToFils(price);
      if (requestedFils < 0) throw new Error("Override price cannot be negative");
      if (reason.trim().length < 3) throw new Error("Enter a clear override reason");
      requestOperation.current ??= operationId("price-override-request");
      const requestId = await callRpc("request_price_override_v1", {
        _tenant_id: tenantId,
        _branch_id: branchId,
        _product_id: line.product.id,
        _channel: channel,
        _quantity: line.quantity,
        _requested_unit_price_fils: requestedFils,
        _reason: reason.trim(),
        _client_mutation_id: requestOperation.current,
        _modifiers: line.product._modifiers ?? [],
      });
      await refresh(String(requestId));
    } catch (error: any) {
      toast.error(error?.message ?? "Could not request the price override");
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!request || request.status !== "approved" || !request.approved_by || !request.approved_at) return;
    onApproved({
      requestId: request.id,
      originalUnitPriceFils: Number(request.original_unit_price_fils),
      overrideUnitPriceFils: Number(request.requested_unit_price_fils),
      approvedQuantity: Number(request.quantity),
      reason: String(request.request_reason),
      approvedBy: request.approved_by,
      approvedAt: request.approved_at,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Price override · {line.product.name}</DialogTitle></DialogHeader>
        {!request ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Current price: {formatFils(currentFils)}. A manager must approve the exact price and quantity before checkout.</p>
            <div className="space-y-1.5">
              <Label htmlFor="override-price">Override price</Label>
              <Input id="override-price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="override-reason">Override reason</Label>
              <Textarea id="override-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required manager evidence" />
            </div>
            <Button className="w-full" disabled={busy} onClick={submit}>Request manager approval</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {request.status === "pending" && <p className="text-sm font-medium">Waiting for manager approval</p>}
            {request.status === "approved" && <p className="text-sm font-medium text-emerald-600">Manager approved {formatFils(Number(request.requested_unit_price_fils))}</p>}
            {request.status === "rejected" && <p className="text-sm font-medium text-destructive">Manager rejected this request</p>}
            {request.status === "expired" && <p className="text-sm font-medium text-destructive">This approval request expired</p>}
            {request.status === "consumed" && <p className="text-sm font-medium text-muted-foreground">This approval was already used</p>}
            {request.status === "approved" ? (
              <Button className="w-full" onClick={apply}>Apply approved price</Button>
            ) : (
              <Button className="w-full" variant="outline" disabled={busy} onClick={() => refresh(request.id)}>Refresh approval status</Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ApprovalsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string;
}

export function PriceOverrideApprovalsDialog({ open, onOpenChange, branchId }: ApprovalsDialogProps) {
  const [requests, setRequests] = useState<OverrideRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const decisionOperations = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setRequests((await callRpc("list_pending_price_overrides_v1", { _branch_id: branchId })) as OverrideRequest[]);
    } catch (error: any) {
      const message = error?.message ?? "Could not load price override requests";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const decide = async (request: OverrideRequest, approve: boolean) => {
    const key = `${request.id}:${approve ? "approve" : "reject"}`;
    decisionOperations.current[key] ??= operationId("price-override-decision");
    try {
      await callRpc("decide_price_override_v1", {
        _request_id: request.id,
        _approve: approve,
        _reason: approve ? "Approved by manager" : "Rejected by manager",
        _client_mutation_id: decisionOperations.current[key],
      });
      toast.success(approve ? "Price override approved" : "Price override rejected");
      await load();
    } catch (error: any) {
      toast.error(error?.message ?? "Could not record the manager decision");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Price override approvals</DialogTitle></DialogHeader>
        {loading ? <p className="text-sm text-muted-foreground">Loading approval requests…</p> : loadError ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-destructive">Approval requests could not be loaded</p>
            <p className="text-xs text-muted-foreground">{loadError}</p>
            <Button variant="outline" aria-label="Retry price override approvals" onClick={load}>Retry</Button>
          </div>
        ) : requests.length === 0 ? (
          <div className="space-y-3"><p className="text-sm text-muted-foreground">No pending requests for this branch.</p><Button variant="outline" onClick={load}>Refresh approvals</Button></div>
        ) : (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {requests.map((request) => (
              <div key={request.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex justify-between gap-3"><strong>{request.product_name ?? "Product"}</strong><span>{formatFils(Number(request.original_unit_price_fils))} → {formatFils(Number(request.requested_unit_price_fils))}</span></div>
                <p className="text-sm text-muted-foreground">{request.request_reason}</p>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" aria-label={`Reject ${request.product_name ?? "Product"} override`} onClick={() => decide(request, false)}>Reject</Button>
                  <Button size="sm" aria-label={`Approve ${request.product_name ?? "Product"} override`} onClick={() => decide(request, true)}>Approve</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
