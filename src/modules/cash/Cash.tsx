import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useAuth } from "@/hooks/useAuth";
import { useOpenSession } from "@/hooks/useOpenSession";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MetricCard } from "@/components/shared/MetricCard";
import { formatCurrency } from "@/lib/format";
import { BAHRAIN_LOCALE, roundBhd } from "@/lib/bahrain";
import { toast } from "sonner";
import {
  LockOpen,
  LockKeyhole,
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  CreditCard,
  Smartphone,
  QrCode,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { PendingTableOrders } from "./PendingTableOrders";
import { cn } from "@/lib/utils";

export default function Cash() {
  const { tenantId, branchId, hasRole } = useTenantContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [openAmount, setOpenAmount] = useState("0.000");
  const [closeOpen, setCloseOpen] = useState(false);
  const [moveDialog, setMoveDialog] = useState<null | "in" | "out">(null);
  const [counts, setCounts] = useState({ cash: "", card: "", transfer: "", qr: "" });

  const { data: session } = useOpenSession(branchId);
  const canViewDifferences = hasRole("owner", "admin");

  const { data: history } = useQuery({
    queryKey: ["cash-history", branchId],
    enabled: !!branchId,
    queryFn: async () =>
      (await supabase
        .from("cash_sessions")
        .select("*")
        .eq("branch_id", branchId!)
        .order("opened_at", { ascending: false })
        .limit(20)).data ?? [],
  });

  const { data: movements } = useQuery({
    queryKey: ["cash-movements", session?.id],
    enabled: !!session?.id,
    queryFn: async () =>
      (await supabase
        .from("cash_movements")
        .select("*")
        .eq("session_id", session!.id)
        .order("created_at", { ascending: false })).data ?? [],
  });

  const expectedCash = session
    ? roundBhd(
        Number(session.opening_amount) +
          Number(session.total_cash) +
          Number(session.total_in) -
          Number(session.total_out)
      )
    : 0;

  const expectedTotal = session
    ? roundBhd(
        expectedCash +
          Number(session.total_card) +
          Number(session.total_transfer) +
          Number(session.total_qr)
      )
    : 0;

  const openSession = async () => {
    if (!tenantId || !branchId || !user) return;
    const { error } = await supabase.rpc("open_cash_session" as any, {
      _tenant_id: tenantId,
      _branch_id: branchId,
      _opening_amount: roundBhd(Number(openAmount) || 0),
    });
    if (error) return toast.error(error.message);
    toast.success("Register opened");
    qc.invalidateQueries();
  };

  const closeSession = async () => {
    if (!session) return;

    const { error } = await supabase.rpc("close_cash_session", {
      _session_id: session.id,
      _counted_amount: roundBhd(Number(counts.cash || 0)),
      _notes: null,
      _counted_card: roundBhd(Number(counts.card || 0)),
      _counted_transfer: roundBhd(Number(counts.transfer || 0)),
      _counted_qr: roundBhd(Number(counts.qr || 0)),
    } as any);

    if (error) return toast.error(error.message);

    toast.success("Register closed successfully");
    setCloseOpen(false);
    setCounts({ cash: "", card: "", transfer: "", qr: "" });
    qc.invalidateQueries();
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="g-page-hd">
          <div className="g-page-hd-eyebrow">OPERATIONS · CASH REGISTER</div>
          <div className="h-display g-page-title">Cash Register</div>
          <div className="g-page-hd-meta">BHD opening, closing, reconciliation, and cash movements</div>
        </div>
        {session && (
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className="g-btn g-btn-ghost" onClick={() => setMoveDialog("in")}>
              <ArrowDownToLine size={16} className="mr-1" /> Cash in
            </button>
            <button type="button" className="g-btn g-btn-ghost" onClick={() => setMoveDialog("out")}>
              <ArrowUpFromLine size={16} className="mr-1" /> Cash out
            </button>
            <button
              type="button"
              className="g-btn g-btn-primary"
              onClick={() => {
                setCounts({ cash: "", card: "", transfer: "", qr: "" });
                setCloseOpen(true);
              }}
            >
              <LockKeyhole size={16} className="mr-1" /> Close register
            </button>
          </div>
        )}
      </div>

      <Tabs defaultValue="current">
        <TabsList>
          <TabsTrigger value="current">Current register</TabsTrigger>
          <TabsTrigger value="history">Closing history</TabsTrigger>
        </TabsList>

        <TabsContent value="current" className="mt-4 space-y-4">
          {!session ? (
            <div className="glass rounded-2xl p-8 max-w-md">
              <div className="flex items-center gap-4 mb-6">
                <div className="orb orb-lg"><LockKeyhole size={26} /></div>
                <div>
                  <div className="h-display-sm">Register closed</div>
                  <div className="g-page-hd-meta">Open the register to start selling</div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="h-label">Opening cash amount</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold g-prefix-muted">BHD</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.001"
                      value={openAmount}
                      onChange={(event) => setOpenAmount(event.target.value)}
                      className="h-14 pl-12 text-2xl font-black tabular-nums border-2 focus:border-primary"
                    />
                  </div>
                </div>
                <button type="button" className="g-btn g-btn-primary g-btn-touch w-full" onClick={openSession}>
                  <LockOpen size={20} className="mr-2" /> Open register now
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <MetricCard icon={Wallet} label="Opening" value={formatCurrency(Number(session.opening_amount))} />
                <MetricCard icon={Banknote} label="Cash" value={formatCurrency(Number(session.total_cash))} />
                <MetricCard icon={CreditCard} label="Card" value={formatCurrency(Number(session.total_card))} />
                <MetricCard icon={Smartphone} label="Bank Transfer" value={formatCurrency(Number(session.total_transfer))} />
                <MetricCard icon={QrCode} label="BenefitPay" value={formatCurrency(Number(session.total_qr))} />
                <MetricCard
                  icon={TrendingUp}
                  label={canViewDifferences ? "Expected total" : "Blind count"}
                  value={canViewDifferences ? formatCurrency(expectedTotal) : "Hidden"}
                  accent
                />
              </div>

              {tenantId && branchId && <PendingTableOrders tenantId={tenantId} branchId={branchId} />}

              <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
                <div className="glass rounded-2xl overflow-hidden">
                  <div className="g-cash-sect-hd">
                    <ArrowDownToLine size={16} className="g-icon-brand" />
                    <div>
                      <div className="g-cash-sect-eyebrow">ACTIVE REGISTER</div>
                      <div className="g-cash-sect-title">Manual cash movements</div>
                    </div>
                  </div>

                  <div className="g-cash-mov-head">
                    <span>Time</span>
                    <span>Type</span>
                    <span className="text-right">Amount</span>
                    <span>Reason</span>
                  </div>

                  {(movements ?? []).length === 0 ? (
                    <div className="py-12 text-center g-page-hd-meta">
                      No manual cash movements in this session
                    </div>
                  ) : (
                    (movements ?? []).map((movement: any) => (
                      <div key={movement.id} className="g-cash-mov-row">
                        <span className="g-cash-mov-time">
                          {new Date(movement.created_at).toLocaleTimeString(BAHRAIN_LOCALE, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span>
                          <span className={movement.type === "in" ? "g-pill g-pill-ok" : "g-pill g-pill-bad"}>
                            {movement.type === "in" ? "Cash in" : "Cash out"}
                          </span>
                        </span>
                        <span className="g-cash-mov-amount">{formatCurrency(Number(movement.amount))}</span>
                        <span className="g-cash-mov-reason">{movement.reason ?? "—"}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="glass rounded-2xl p-5">
                  <div className="h-label-caps mb-4">Sales summary</div>
                  <div className="g-cash-summary">
                    <div className="g-cash-summary-row">
                      <span>Recorded payments</span>
                      <span className="g-cash-summary-val">
                        {formatCurrency(
                          Number(session.total_cash) +
                            Number(session.total_card) +
                            Number(session.total_transfer) +
                            Number(session.total_qr)
                        )}
                      </span>
                    </div>
                    <div className="g-cash-summary-row">
                      <span>Cash in</span>
                      <span className="g-cash-summary-val g-cash-summary-ok">+{formatCurrency(Number(session.total_in))}</span>
                    </div>
                    <div className="g-cash-summary-row">
                      <span>Cash out</span>
                      <span className="g-cash-summary-val g-cash-summary-bad">−{formatCurrency(Number(session.total_out))}</span>
                    </div>
                    <div className="g-cash-summary-total">
                      <span>{canViewDifferences ? "Expected balance" : "Balance"}</span>
                      <span className="g-cash-summary-total-val">
                        {canViewDifferences ? formatCurrency(expectedTotal) : "Hidden"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <div className="glass rounded-2xl overflow-hidden">
            <div className="g-cash-hist-head">
              <span>Opened / Closed</span>
              <span>Status</span>
              <span className="text-right">Expected</span>
              <span className="text-right">Counted</span>
              <span className="text-right">Difference</span>
            </div>

            {(history ?? []).map((row: any) => {
              const difference = Number(row.difference ?? 0);
              const differenceClass = difference < 0
                ? "g-cash-hist-diff-bad"
                : difference > 0
                  ? "g-cash-hist-diff-ok"
                  : "g-cash-hist-diff-neu";

              return (
                <div key={row.id} className="g-cash-hist-row">
                  <div>
                    <div className="g-cash-hist-date-main">
                      {new Date(row.opened_at).toLocaleDateString(BAHRAIN_LOCALE)}
                    </div>
                    <div className="g-cash-hist-date-time">
                      {new Date(row.opened_at).toLocaleTimeString(BAHRAIN_LOCALE)} — {row.closed_at
                        ? new Date(row.closed_at).toLocaleTimeString(BAHRAIN_LOCALE)
                        : "Open"}
                    </div>
                  </div>
                  <span className="g-cash-hist-dim capitalize">{row.status}</span>
                  <span className="g-cash-hist-num">
                    {canViewDifferences && row.expected_amount != null
                      ? formatCurrency(Number(row.expected_amount))
                      : "Hidden"}
                  </span>
                  <span className="g-cash-hist-num">
                    {row.closing_amount != null ? formatCurrency(Number(row.closing_amount)) : "—"}
                  </span>
                  <span className={cn(differenceClass)}>
                    {canViewDifferences && row.difference != null
                      ? `${difference > 0 ? "+" : ""}${formatCurrency(difference)}`
                      : "Hidden"}
                  </span>
                </div>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 py-4 border-b bg-muted/20">
            <DialogTitle className="flex items-center gap-2">
              <LockKeyhole className="h-5 w-5 text-primary" /> Register Closing Audit
            </DialogTitle>
          </DialogHeader>
          <div className="p-6 space-y-6">
            <CountField label="Counted Cash" value={counts.cash} onChange={(value) => setCounts({ ...counts, cash: value })} />
            <div className="space-y-3 border-t pt-4">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Other payment methods
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <CountField label="Card" value={counts.card} onChange={(value) => setCounts({ ...counts, card: value })} compact />
                <CountField label="Bank Transfer" value={counts.transfer} onChange={(value) => setCounts({ ...counts, transfer: value })} compact />
                <CountField label="BenefitPay" value={counts.qr} onChange={(value) => setCounts({ ...counts, qr: value })} compact />
              </div>
            </div>
            <button type="button" className="g-btn g-btn-primary g-btn-touch w-full" onClick={closeSession}>
              Close register
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <CashMovementDialog
        open={moveDialog !== null}
        type={moveDialog ?? "in"}
        sessionId={session?.id ?? null}
        onClose={() => {
          setMoveDialog(null);
          qc.invalidateQueries({ queryKey: ["cash-movements"] });
          qc.invalidateQueries({ queryKey: ["open-session"] });
        }}
      />
    </div>
  );
}

function CountField({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className={compact ? "text-[10px]" : "text-[10px] font-black uppercase tracking-widest"}>{label}</Label>
      <Input
        type="number"
        min="0"
        step="0.001"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={compact ? "h-8 text-sm" : "font-bold tabular-nums"}
        placeholder="0.000"
      />
    </div>
  );
}

function CashMovementDialog({
  open,
  type,
  sessionId,
  onClose,
}: {
  open: boolean;
  type: "in" | "out";
  sessionId: string | null;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!sessionId) return;
    setSaving(true);
    const { error } = await supabase.rpc("add_cash_movement", {
      _session_id: sessionId,
      _type: type,
      _amount: roundBhd(Number(amount) || 0),
      _reason: reason || null,
    });
    setSaving(false);

    if (error) return toast.error(error.message);

    toast.success(type === "in" ? "Cash in recorded" : "Cash out recorded");
    setAmount("");
    setReason("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{type === "in" ? "Record cash in" : "Record cash out"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Amount (BHD)</Label>
            <Input
              type="number"
              min="0"
              step="0.001"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="h-12 text-lg"
              placeholder="0.000"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={type === "in" ? "e.g. Extra float" : "e.g. Supplier payment"}
            />
          </div>
          <button
            type="button"
            className="g-btn g-btn-primary g-btn-touch w-full"
            disabled={saving || !amount}
            onClick={submit}
          >
            Record
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
