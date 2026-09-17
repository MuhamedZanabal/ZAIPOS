import { useCallback, useEffect, useState } from "react";
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
import { BAHRAIN_LOCALE, bhdToFils, filsToBhd, roundBhd } from "@/lib/bahrain";
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
import { clearCompletedCashMovement, executeCashMovement, readCashMovement, type CashMovementDraft } from "@/lib/cashMovementRecovery";

import { acknowledgeCashSession, readCashSession, recoverCashSession, startCashSessionOperation, type CashSessionDraft, type CashSessionRequest } from '@/lib/cashSessionRecovery';

export default function Cash() {
  const { tenantId, branchId, hasRole } = useTenantContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const actorId = user?.id;
  const [openAmount, setOpenAmount] = useState("0.000");
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionDraft, setSessionDraft] = useState<CashSessionDraft | null>(null);
  const [sessionRecoveryError, setSessionRecoveryError] = useState('');
  const refreshSessionRecovery = useCallback(() => {
    try { setSessionDraft(actorId ? readCashSession(actorId) : null); setSessionRecoveryError(''); }
    catch (error: any) { setSessionRecoveryError(error.message); }
  }, [actorId]);
  useEffect(() => {
    refreshSessionRecovery();
    window.addEventListener('storage', refreshSessionRecovery);
    return () => window.removeEventListener('storage', refreshSessionRecovery);
  }, [refreshSessionRecovery]);
  const sessionBlocked = sessionSaving || !!sessionDraft || !!sessionRecoveryError;
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

  const exactCount = (value: string) => {
    if (!value.trim()) throw new Error('Enter every counted amount explicitly, including zero');
    const fils = bhdToFils(value);
    if (fils < 0) throw new Error('Cash amounts cannot be negative');
    return filsToBhd(fils);
  };
  const submitSession = async (request?: CashSessionRequest, cancel = false) => {
    if (!user || sessionSaving) return;
    setSessionSaving(true);
    try {
      const result = request ? await startCashSessionOperation(user.id, request) : await recoverCashSession(user.id, cancel);
      if (result.state === 'rejected') toast.error('Operation identity belongs to a different request. Reconcile before continuing.');
      else toast.success(result.state === 'cancelled' ? 'Session request cancelled without changing a register' : 'Original session operation confirmed');
      setCloseOpen(false); qc.invalidateQueries();
    } catch (error: any) { toast.error(error.message ?? 'Session response uncertain. Recover the saved request.'); }
    finally { refreshSessionRecovery(); setSessionSaving(false); }
  };
  const openSession = async () => {
    if (!tenantId || !branchId || sessionBlocked) return;
    try { await submitSession({kind:'open',tenant_id:tenantId,branch_id:branchId,register_id:null,opening_amount:exactCount(openAmount)}); }
    catch (error: any) { toast.error(error.message); }
  };
  const closeSession = async () => {
    if (!session || !tenantId || !branchId || sessionBlocked) return;
    try { await submitSession({kind:'close',tenant_id:tenantId,branch_id:branchId,session_id:session.id,
      counted_cash:exactCount(counts.cash),counted_card:exactCount(counts.card),counted_transfer:exactCount(counts.transfer),counted_qr:exactCount(counts.qr),notes:null}); }
    catch (error: any) { toast.error(error.message); }
  };
  const acknowledgeSession = async () => {
    if (!user || sessionSaving) return;
    setSessionSaving(true);
    try { await acknowledgeCashSession(user.id); }
    catch (error: any) { toast.error(error.message); }
    finally { refreshSessionRecovery();setSessionSaving(false); }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="g-page-hd">
          <div className="g-page-hd-eyebrow">OPERATIONS · CASH REGISTER</div>
          <div className="h-display g-page-title">Cash Register</div>
          <div className="g-page-hd-meta">BHD opening, closing, reconciliation, and cash movements</div>
        </div>
        <button type="button" className="g-btn g-btn-ghost" onClick={() => setMoveDialog("in")}>Cash movement recovery</button>
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
              disabled={sessionBlocked}
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

      {sessionRecoveryError && <p role="alert">{sessionRecoveryError}</p>}
      {sessionDraft && <section className="glass rounded-2xl p-4 space-y-3" aria-label="Session recovery">
        <p role="status">Saved {sessionDraft.request.kind} request: {sessionDraft.state}. Operation {sessionDraft.operationId}</p>
        <p>Original branch: {sessionDraft.request.branch_id}. {sessionDraft.request.kind === 'open' ? `Opening cash: ${sessionDraft.request.opening_amount} BHD` : `Session: ${sessionDraft.request.session_id}. Counts (BHD): cash ${sessionDraft.request.counted_cash}, card ${sessionDraft.request.counted_card}, bank transfer ${sessionDraft.request.counted_transfer}, BenefitPay ${sessionDraft.request.counted_qr}.`}</p>
        {sessionDraft.sessionId && <p>Confirmed session: {sessionDraft.sessionId}. This receipt describes the original operation; check current register status before selling.</p>}
        {sessionDraft.state === 'pending' ? <>
          <button type="button" className="g-btn g-btn-primary" disabled={sessionSaving || !!sessionRecoveryError} onClick={() => submitSession()}>Retry saved session request</button>
          <button type="button" className="g-btn g-btn-ghost" disabled={sessionSaving || !!sessionRecoveryError} onClick={() => submitSession(undefined,true)}>Resolve session cancellation</button>
          <p>Cancellation only prevents an uncommitted request. A committed opening or closing is retained and confirmed.</p>
        </> : <button type="button" className="g-btn g-btn-ghost" disabled={sessionSaving || !!sessionRecoveryError} onClick={acknowledgeSession}>Acknowledge session receipt</button>}
      </section>}
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
                      disabled={sessionBlocked}
                      value={openAmount}
                      onChange={(event) => setOpenAmount(event.target.value)}
                      className="h-14 pl-12 text-2xl font-black tabular-nums border-2 focus:border-primary"
                    />
                  </div>
                </div>
                <button type="button" className="g-btn g-btn-primary g-btn-touch w-full" disabled={sessionBlocked} onClick={openSession}>
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
            <CountField disabled={sessionBlocked} label="Counted Cash" value={counts.cash} onChange={(value) => setCounts({ ...counts, cash: value })} />
            <div className="space-y-3 border-t pt-4">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Other payment methods
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <CountField disabled={sessionBlocked} label="Card" value={counts.card} onChange={(value) => setCounts({ ...counts, card: value })} compact />
                <CountField disabled={sessionBlocked} label="Bank Transfer" value={counts.transfer} onChange={(value) => setCounts({ ...counts, transfer: value })} compact />
                <CountField disabled={sessionBlocked} label="BenefitPay" value={counts.qr} onChange={(value) => setCounts({ ...counts, qr: value })} compact />
              </div>
            </div>
            <button type="button" className="g-btn g-btn-primary g-btn-touch w-full" disabled={sessionBlocked} onClick={closeSession}>
              Close register
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <CashMovementDialog
        actorId={user?.id ?? null}
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
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className={compact ? "text-[10px]" : "text-[10px] font-black uppercase tracking-widest"}>{label}</Label>
      <Input
        type="number"
        min="0"
        step="0.001"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={compact ? "h-8 text-sm" : "font-bold tabular-nums"}
        placeholder="0.000"
      />
    </div>
  );
}

export function CashMovementDialog({
  open, type, sessionId, actorId, onClose,
}: {
  open: boolean;
  type: "in" | "out";
  sessionId: string | null;
  actorId: string | null;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [draft, setDraft] = useState<CashMovementDraft | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [saving, setSaving] = useState(false);
  const recover = useCallback(() => {
    try {
      const saved = actorId ? readCashMovement(actorId) : null;
      setDraft(saved);
      setAmount(saved?.request._amount ?? "");
      setReason(saved?.request._reason ?? "");
      setReference(saved?.request._reference ?? "");
      setRecoveryError("");
    } catch (error: any) { setRecoveryError(error.message); }
  }, [actorId]);
  useEffect(() => { if (open) recover(); }, [open, recover]);
  const submit = async (cancel = false) => {
    if (!actorId || saving) return;
    setSaving(true);
    try {
      const request = draft?.request ?? {
        _session_id: sessionId ?? "", _type: type,
        _amount: filsToBhd(bhdToFils(amount)), _reason: reason.trim(), _reference: reference.trim(),
      };
      const completed = await executeCashMovement(actorId, request, cancel);
      setDraft(completed);
      if (completed.state === 'rejected') toast.error('Reference already belongs to a different request. Verify the voucher before starting another movement.');
      else toast.success(completed.state === 'cancelled' ? 'Movement cancelled before recording cash' : 'Cash movement confirmed');
      // Retain the confirmed reference until an explicit new physical movement.
    } catch (error: any) {
      toast.error(error.message ?? 'Cash movement response is uncertain; recover the original reference');
      try { if (actorId) setDraft(readCashMovement(actorId)); }
      catch (readError: any) { setRecoveryError(readError.message); }
    } finally { setSaving(false); }
  };
  const startAnother = async () => {
    if (!actorId) return;
    setSaving(true);
    try { await clearCompletedCashMovement(actorId); recover(); }
    catch (error: any) { toast.error(error.message); }
    finally { setSaving(false); }
  };
  const locked = saving || !!draft || !!recoveryError;
  const movementType = draft?.request._type ?? type;
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{movementType === 'in' ? 'Record cash in' : 'Record cash out'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {recoveryError && <p role="alert">{recoveryError}</p>}
          {draft && <p role="status">{draft.state === 'pending' ? 'Saved movement awaiting confirmation. Retry or cancel this same request before starting another.' : `Movement ${draft.state}. Reference: ${draft.request._reference}`}</p>}
          {draft && draft.request._session_id !== sessionId && <p>This saved movement belongs to an earlier cash session. Recovery uses that original session.</p>}
          <div className="space-y-1.5">
            <Label htmlFor="cash-movement-reference">Movement reference</Label>
            <Input id="cash-movement-reference" value={reference} disabled={locked} maxLength={128} onChange={event => setReference(event.target.value)} placeholder="e.g. FLOAT-20260915-001" />
            <p className="text-xs">Use one unique voucher reference per physical movement. Reuse it after a network failure.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Amount (BHD)</Label>
            <Input type="number" min="0" step="0.001" value={amount} disabled={locked} onChange={event => setAmount(event.target.value)} className="h-12 text-lg" placeholder="0.000" />
          </div>
          <div className="space-y-1.5">
            <Label>Reason (required)</Label>
            <Input value={reason} disabled={locked} onChange={event => setReason(event.target.value)} placeholder={movementType === 'in' ? 'e.g. Extra float' : 'e.g. Safe withdrawal'} />
          </div>
          {(!draft || draft.state === 'pending') ? <>
            <button type="button" className="g-btn g-btn-primary g-btn-touch w-full" disabled={saving || !!recoveryError || !actorId || !amount || !reference || reason.trim().length < 2} onClick={() => submit()}>Record</button>
            {draft && <button type="button" className="g-btn g-btn-ghost w-full" disabled={saving || !!recoveryError} onClick={() => submit(true)}>Resolve cancellation</button>}
          </> : <button type="button" className="g-btn g-btn-primary w-full" disabled={saving || !!recoveryError || !sessionId} onClick={startAnother}>Start another physical movement</button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
