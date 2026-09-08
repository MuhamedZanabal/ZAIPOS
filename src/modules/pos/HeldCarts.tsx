import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatFils } from "@/lib/bahrain";
import type { CartLine } from "@/stores/cart";
import type { SalesChannel } from "@/lib/channels";
import {
  buildHeldCartResumeRequest,
  buildResumedCartLines,
  heldCartIssueLabel,
  heldCartPriceChange,
  serializeHeldCartLines,
  type HeldCartResolutions,
  type HeldCartResumePreview,
  type HeldCartSummary,
} from "./heldCartModel";

const HELD_CART_QUERY_KEY = "held-carts";

interface HoldCartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string | null | undefined;
  channel: SalesChannel;
  customerId: string | null;
  tableId: string | null;
  lines: CartLine[];
  onHeld: () => void;
}

export function HoldCartDialog({
  open,
  onOpenChange,
  branchId,
  channel,
  customerId,
  tableId,
  lines,
  onHeld,
}: HoldCartDialogProps) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const operation = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => { if (!open) setLabel(""); }, [open]);

  const hold = async () => {
    if (!branchId || lines.length === 0 || saving) return;
    setSaving(true);
    try {
      const items = serializeHeldCartLines(lines);
      const operationKey = JSON.stringify({ branchId, label: label.trim() || "Held cart", channel, customerId, tableId, items });
      if (operation.current?.key !== operationKey) {
        operation.current = { key: operationKey, id: crypto.randomUUID() };
      }
      const { error } = await supabase.rpc("hold_cart_v1", {
        _branch_id: branchId,
        _label: label.trim() || "Held cart",
        _channel: channel,
        _customer_id: customerId,
        _table_id: tableId,
        _items: items,
        _client_operation_id: operation.current.id,
      });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: [HELD_CART_QUERY_KEY, branchId] });
      onHeld();
      operation.current = null;
      onOpenChange(false);
      toast.success("Cart held");
    } catch (error: any) {
      toast.error("Cart could not be held", { description: error?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hold current cart</DialogTitle>
          <DialogDescription>Save this ticket for this branch and resume it later.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="held-cart-label">Cart label</Label>
          <Input
            id="held-cart-label"
            value={label}
            maxLength={120}
            placeholder="Customer or order reference"
            onChange={(event) => setLabel(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{lines.length} line{lines.length === 1 ? "" : "s"} will be saved.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void hold()} disabled={!branchId || lines.length === 0 || saving}>
            <Archive className="mr-2 h-4 w-4" /> {saving ? "Holding…" : "Hold cart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface HeldCartsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchId: string | null | undefined;
  onResumed: (value: {
    lines: CartLine[];
    channel: SalesChannel;
    customerId: string | null;
    tableId: string | null;
  }) => void;
}

export function HeldCartsDialog({ open, onOpenChange, branchId, onResumed }: HeldCartsDialogProps) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<HeldCartResumePreview | null>(null);
  const [resolutions, setResolutions] = useState<HeldCartResolutions>({});
  const [busy, setBusy] = useState(false);
  const resumeOperation = useRef<{ key: string; id: string } | null>(null);
  const discardOperations = useRef(new Map<string, string>());

  const { data: carts = [], isLoading } = useQuery<HeldCartSummary[]>({
    queryKey: [HELD_CART_QUERY_KEY, branchId],
    enabled: open && !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_held_carts_v1", { _branch_id: branchId! });
      if (error) throw error;
      return (data ?? []) as unknown as HeldCartSummary[];
    },
  });

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setResolutions({});
      resumeOperation.current = null;
    }
  }, [open]);

  const request = useMemo(
    () => preview ? buildHeldCartResumeRequest(preview, resolutions) : null,
    [preview, resolutions],
  );
  const hasRemainingItems = request?.items.some((item) => !item.remove) ?? false;

  const review = async (cartId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("preview_held_cart_resume_v1", { _held_cart_id: cartId });
      if (error) throw error;
      setPreview(data as unknown as HeldCartResumePreview);
      setResolutions({});
      resumeOperation.current = null;
    } catch (error: any) {
      toast.error("Held cart could not be reviewed", { description: error?.message });
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!preview || !request?.ready || !hasRemainingItems || busy) return;
    setBusy(true);
    try {
      const operationKey = JSON.stringify({ cartId: preview.cart.id, items: request.items });
      if (resumeOperation.current?.key !== operationKey) {
        resumeOperation.current = { key: operationKey, id: crypto.randomUUID() };
      }
      const { data, error } = await supabase.rpc("resume_held_cart_v1", {
        _held_cart_id: preview.cart.id,
        _resolutions: request.items,
        _client_operation_id: resumeOperation.current.id,
      });
      if (error) throw error;
      const result = data as unknown as HeldCartResumePreview;
      onResumed({
        lines: buildResumedCartLines(result),
        channel: result.cart.channel,
        customerId: result.cart.customer_id,
        tableId: result.cart.table_id,
      });
      await queryClient.invalidateQueries({ queryKey: [HELD_CART_QUERY_KEY, branchId] });
      resumeOperation.current = null;
      onOpenChange(false);
      toast.success("Held cart resumed");
    } catch (error: any) {
      toast.error("Held cart changed again", {
        description: error?.message ?? "Review the latest product, price and stock state.",
      });
      if (!/fetch|network|timeout|connection/i.test(error?.message ?? "")) {
        const { data: latest } = await supabase.rpc("preview_held_cart_resume_v1", {
          _held_cart_id: preview.cart.id,
        });
        if (latest) {
          setPreview(latest as unknown as HeldCartResumePreview);
          setResolutions({});
          resumeOperation.current = null;
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const discard = async (cart: HeldCartSummary) => {
    if (busy || !window.confirm(`Discard held cart "${cart.label}"?`)) return;
    setBusy(true);
    try {
      const operationId = discardOperations.current.get(cart.id) ?? crypto.randomUUID();
      discardOperations.current.set(cart.id, operationId);
      const { error } = await supabase.rpc("discard_held_cart_v1", {
        _held_cart_id: cart.id,
        _reason: "Discarded by cashier from POS",
        _client_operation_id: operationId,
      });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: [HELD_CART_QUERY_KEY, branchId] });
      discardOperations.current.delete(cart.id);
      toast.success("Held cart discarded");
    } catch (error: any) {
      toast.error("Held cart could not be discarded", { description: error?.message });
    } finally {
      setBusy(false);
    }
  };

  const patchResolution = (lineId: string, value: Partial<HeldCartResolutions[string]>) => {
    setResolutions((current) => ({
      ...current,
      [lineId]: { ...current[lineId], ...value },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{preview ? preview.cart.label : "Held carts"}</DialogTitle>
          <DialogDescription>
            {preview ? "Resolve every changed product, price or stock condition before resuming." : "Branch-held tickets available to resume."}
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="space-y-2">
            {isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Loading held carts…</p>}
            {!isLoading && carts.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No held carts for this branch.</p>}
            {carts.map((cart) => (
              <div key={cart.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{cart.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {cart.item_count} line{cart.item_count === 1 ? "" : "s"} · {formatFils(cart.total_fils)} · {cart.created_by_name}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Discard held cart ${cart.label}`}
                    onClick={() => void discard(cart)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" aria-label={`Review held cart ${cart.label}`} onClick={() => void review(cart.id)}>
                    <RotateCcw className="mr-2 h-4 w-4" /> Review
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {preview.items.map((item) => {
              const resolution = resolutions[item.line_id] ?? {};
              const mustRemove = item.issues.some((issue) => ["product_discontinued", "branch_unavailable", "modifier_unavailable"].includes(issue));
              return (
                <div key={item.line_id} className="rounded-xl border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{item.product_name}</p>
                      <p className="text-xs text-muted-foreground">Held quantity: {item.quantity}</p>
                    </div>
                    {resolution.remove && <span className="text-xs font-medium text-destructive">Will be removed</span>}
                  </div>
                  {item.issues.map((issue) => (
                    <div key={issue} className="flex items-center justify-between gap-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
                      <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /> {heldCartIssueLabel(issue)}</span>
                      {issue === "price_changed" && !resolution.remove && (
                        <Button size="sm" variant="outline" aria-label={`Accept ${formatFils(item.current_unit_price_fils ?? 0)}`} onClick={() => patchResolution(item.line_id, { acceptCurrentPrice: true })}>
                          {resolution.acceptCurrentPrice ? "Accepted" : heldCartPriceChange(item)}
                        </Button>
                      )}
                      {issue === "insufficient_stock" && !resolution.remove && item.available_quantity !== null && item.available_quantity > 0 && (
                        <Button size="sm" variant="outline" aria-label={`Reduce to ${item.available_quantity}`} onClick={() => patchResolution(item.line_id, { quantity: item.available_quantity })}>
                          Reduce to {item.available_quantity}
                        </Button>
                      )}
                    </div>
                  ))}
                  {item.issues.length > 0 && (
                    <Button size="sm" variant={mustRemove ? "destructive" : "ghost"} onClick={() => patchResolution(item.line_id, { remove: true })}>
                      Remove item
                    </Button>
                  )}
                </div>
              );
            })}
            {request && !request.ready && (
              <p className="text-sm text-amber-700">Resolve {request.unresolvedLineIds.length} changed line{request.unresolvedLineIds.length === 1 ? "" : "s"}.</p>
            )}
            {request?.ready && !hasRemainingItems && (
              <p className="text-sm text-destructive">At least one available item is required to resume. Discard this cart instead.</p>
            )}
          </div>
        )}

        <DialogFooter>
          {preview && <Button variant="outline" onClick={() => { setPreview(null); setResolutions({}); }}>Back</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {preview && (
            <Button onClick={() => void resume()} disabled={!request?.ready || !hasRemainingItems || busy}>
              Resume cart
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
