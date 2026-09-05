import { useCallback, useEffect, useState } from "react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Send,
  RotateCcw,
} from "lucide-react";
import { useSyncEngine } from "@/hooks/useSyncEngine";
import type { SyncQueueItem, SyncQueueStatus } from "@/lib/db";
import { isReplayableQueueStatus } from "@/lib/syncQueue";
import { formatDistanceToNow } from "date-fns";

const TYPE_LABELS: Record<string, string> = {
  CHECKOUT_SALE_V2: "POS Sale",
  CHECKOUT_SALE: "POS Sale",
  CHECKOUT_TABLE_ORDER: "Table checkout",
  SEND_TO_KITCHEN: "Send to kitchen",
  MARK_ORDER_READY: "Order ready",
  SEND_TO_CASHIER: "Send to register",
  APPLY_INVENTORY_MOVEMENT: "Inventory movement",
  ADD_TABLE_ORDER_ITEMS: "Table items",
  UPSERT_TABLE_ORDER_ITEMS: "Table order",
};

const STATUS_LABELS: Record<SyncQueueStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  committed: "Committed",
  retrying: "Retrying",
  failed: "Failed",
  requires_review: "Requires review",
};

const FAILURE_LABELS: Record<string, string> = {
  network: "Network unavailable",
  retry_exhausted: "Retry limit reached",
  unknown_operation: "Unsupported queued operation",
  operation_conflict: "Operation ID conflict",
  branch_changed: "Branch changed",
  cash_session_closed: "Cash session closed",
  customer_changed: "Customer changed",
  product_unavailable: "Product unavailable",
  coupon_changed: "Coupon changed",
  payment_mismatch: "Price or total changed",
  stock_conflict: "Stock conflict",
  authorization: "Authorization required",
  validation: "Server validation failed",
};

function StatusIcon({ status }: { status: SyncQueueStatus }) {
  if (status === "committed") return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (status === "sending") return <Send className="h-4 w-4 text-blue-600" />;
  if (status === "retrying") return <RefreshCw className="h-4 w-4 text-amber-500" />;
  if (status === "failed" || status === "requires_review") {
    return <AlertCircle className="h-4 w-4 text-destructive" />;
  }
  return <Clock className="h-4 w-4 text-amber-500" />;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function SyncQueuePanel({ open, onOpenChange }: Props) {
  const { processSyncQueue, getQueueItems, discardItem, retryItem } = useSyncEngine();
  const [items, setItems] = useState<SyncQueueItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [discarding, setDiscarding] = useState<number | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const rows = await getQueueItems();
    setItems(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, [getQueueItems]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleSync = async () => {
    setSyncing(true);
    await processSyncQueue();
    await refresh();
    setSyncing(false);
  };

  const handleDiscard = async (id: number) => {
    const confirmed = window.confirm(
      "Discard this local transaction record? This cannot be undone and may require manual reconciliation."
    );
    if (!confirmed) return;
    setDiscarding(id);
    await discardItem(id);
    await refresh();
    setDiscarding(null);
  };

  const handleRetry = async (id: number) => {
    setRetrying(id);
    await retryItem(id);
    await processSyncQueue();
    await refresh();
    setRetrying(null);
  };

  const pending = items.filter((item) => isReplayableQueueStatus(item.status)).length;
  const attention = items.filter((item) =>
    item.status === "failed" || item.status === "requires_review"
  ).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            Sync Queue
            {pending > 0 && (
              <Badge className="bg-amber-500 text-white">{pending} pending</Badge>
            )}
            {attention > 0 && (
              <Badge variant="destructive">
                {attention} need{attention === 1 ? "s" : ""} attention
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            Local transactions and their latest synchronization result.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-2 px-6 py-3 border-b">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSync}
            disabled={syncing || pending === 0}
            className="gap-1.5"
          >
            {syncing
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            Sync now
          </Button>
          <Button size="sm" variant="ghost" onClick={refresh} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh list
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-3">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
              <div>
                <p className="font-medium text-foreground">Queue empty</p>
                <p className="text-sm">All transactions are synchronized.</p>
              </div>
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 p-3 rounded-lg border bg-card"
              >
                <div className="mt-0.5 shrink-0">
                  <StatusIcon status={item.status} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {TYPE_LABELS[item.type] ?? item.type}
                    </span>
                    <Badge
                      variant={item.status === "failed" || item.status === "requires_review"
                        ? "destructive"
                        : item.status === "committed"
                          ? "outline"
                          : "secondary"}
                      className="text-[10px] h-4"
                    >
                      {STATUS_LABELS[item.status]}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                    {item.deviceId && ` · Device: ${item.deviceId.slice(0, 8)}…`}
                  </p>
                  {item.failureCode && (
                    <p className="text-xs font-medium text-destructive mt-1">
                      {FAILURE_LABELS[item.failureCode] ?? item.failureCode}
                    </p>
                  )}
                  {item.error && (
                    <p className="text-xs text-destructive mt-1 font-mono break-all">
                      {item.error}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {(item.status === "failed" || item.status === "requires_review") && (
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      aria-label={`Retry ${TYPE_LABELS[item.type] ?? item.type}`}
                      disabled={retrying === item.id}
                      onClick={() => item.id !== undefined && handleRetry(item.id)}
                    >
                      {retrying === item.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RotateCcw className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  {item.status !== "sending" && item.status !== "committed" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label={`Discard ${TYPE_LABELS[item.type] ?? item.type}`}
                      disabled={discarding === item.id}
                      onClick={() => item.id !== undefined && handleDiscard(item.id)}
                    >
                      {discarding === item.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
