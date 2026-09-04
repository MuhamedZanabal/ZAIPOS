import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import { Banknote, CreditCard, Smartphone, QrCode, Loader2, Heart, Tag, Plus, Trash2 } from "lucide-react";
import { NumPad } from "./NumPad";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { BHD_CASH_SHORTCUTS } from "@/lib/bahrain";
import {
  addFils,
  bhdToFils,
  filsToBhd,
  percentageOfFils,
  subtractFils,
  type Fils,
} from "@/lib/money";
import {
  addPaymentAllocation,
  allocationTotalFils,
  assertAllocationsSettle,
  remainingPaymentFils,
  removePaymentAllocation,
  type PaymentAllocation,
  type PayMethod,
} from "./paymentAllocations";

export type { PayMethod, PaymentAllocation } from "./paymentAllocations";

export const paymentMethodLabel = (method: PayMethod) => {
  switch (method) {
    case "cash": return "Cash";
    case "card": return "Card";
    case "qr": return "BenefitPay";
    case "transfer": return "Bank Transfer";
  }
};

interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: number;
  tenantId?: string | null;
  submitting: boolean;
  onConfirm: (
    allocations: PaymentAllocation[],
    tip: number,
    couponCode?: string,
    discount?: number,
  ) => void;
}

const METHODS = [
  { id: "cash" as const, label: "Cash", icon: Banknote },
  { id: "card" as const, label: "Card", icon: CreditCard },
  { id: "qr" as const, label: "BenefitPay", icon: QrCode },
  { id: "transfer" as const, label: "Bank Transfer", icon: Smartphone },
];

const TIP_SUGGESTIONS = [
  { label: "0%", percent: 0 },
  { label: "5%", percent: 5 },
  { label: "10%", percent: 10 },
  { label: "15%", percent: 15 },
] as const;

const SHORTCUTS = [...BHD_CASH_SHORTCUTS];
const amountText = (fils: Fils) => filsToBhd(fils).toFixed(3);

export function PaymentDialog({ open, onOpenChange, total, tenantId, submitting, onConfirm }: PaymentDialogProps) {
  const [method, setMethod] = useState<PayMethod>("cash");
  const [entryAmount, setEntryAmount] = useState("");
  const [reference, setReference] = useState("");
  const [allocations, setAllocations] = useState<PaymentAllocation[]>([]);
  const [tipFils, setTipFils] = useState<Fils>(0);
  const [coupon, setCoupon] = useState("");
  const [couponDiscountFils, setCouponDiscountFils] = useState<Fils>(0);
  const [validatingCoupon, setValidatingCoupon] = useState(false);

  const saleTotalFils = useMemo(() => bhdToFils(total), [total]);
  const discountedTotalFils = Math.max(0, subtractFils(saleTotalFils, Math.min(couponDiscountFils, saleTotalFils)));
  const grandTotalFils = addFils(discountedTotalFils, tipFils);
  const allocatedFils = allocationTotalFils(allocations);
  const remainingFils = Math.max(0, remainingPaymentFils(grandTotalFils, allocations));

  useEffect(() => {
    if (!open) return;
    setMethod("cash");
    setReference("");
    setAllocations([]);
    setTipFils(0);
    setCoupon("");
    setCouponDiscountFils(0);
    setEntryAmount(amountText(bhdToFils(total)));
  }, [open, total]);

  // Tip/coupon changes alter the amount being settled. Never silently mutate existing
  // allocations: reset them and force the operator to re-confirm the payment split.
  useEffect(() => {
    if (!open) return;
    setAllocations((current) => {
      if (current.length === 0) return current;
      toast.info("Payment allocations were cleared because the payable total changed.");
      return [];
    });
  }, [grandTotalFils, open]);

  useEffect(() => {
    if (!open || remainingFils <= 0) return;
    setEntryAmount(amountText(remainingFils));
    setReference("");
  }, [method, remainingFils, open]);

  const entryFils = (() => {
    try {
      return bhdToFils(entryAmount || 0);
    } catch {
      return 0;
    }
  })();

  const cashChangeFils = method === "cash" && entryFils > remainingFils
    ? subtractFils(entryFils, remainingFils)
    : 0;

  const allocationCandidateFils = method === "cash"
    ? Math.min(entryFils, remainingFils)
    : entryFils;

  const invalidEntry = remainingFils > 0 && (
    allocationCandidateFils <= 0 || allocationCandidateFils > remainingFils
  );

  const handleTipPercent = (percent: number) => {
    setTipFils(percentageOfFils(discountedTotalFils, percent));
  };

  const applyCoupon = async () => {
    const code = coupon.trim().toUpperCase();
    if (!code) {
      setCouponDiscountFils(0);
      return;
    }
    if (!tenantId) return toast.error("There is no active business to validate the coupon");

    setValidatingCoupon(true);
    try {
      const { data, error } = await supabase
        .from("discount_codes" as any)
        .select("code, discount_type, discount_value, starts_at, expires_at, max_uses, current_uses, is_active")
        .eq("tenant_id", tenantId)
        .eq("code", code)
        .eq("is_active", true)
        .maybeSingle();

      if (error) throw error;

      const now = Date.now();
      if (!data || new Date(data.starts_at).getTime() > now || (data.expires_at && new Date(data.expires_at).getTime() < now)) {
        setCouponDiscountFils(0);
        return toast.error("Invalid or expired coupon");
      }
      if (data.max_uses != null && Number(data.current_uses) >= Number(data.max_uses)) {
        setCouponDiscountFils(0);
        return toast.error("Coupon has no remaining uses");
      }

      const discountFils = data.discount_type === "percentage"
        ? percentageOfFils(saleTotalFils, Number(data.discount_value))
        : bhdToFils(Number(data.discount_value));
      const bounded = Math.min(saleTotalFils, Math.max(0, discountFils));
      setCouponDiscountFils(bounded);
      toast.success(`Coupon applied · -${formatCurrency(filsToBhd(bounded))}`);
    } catch (error: any) {
      toast.error(error.message ?? "Could not validate the coupon");
    } finally {
      setValidatingCoupon(false);
    }
  };

  const addAllocation = () => {
    if (remainingFils <= 0) return;
    if (invalidEntry) return toast.error("Enter a valid amount within the remaining balance");

    try {
      const next: PaymentAllocation = {
        method,
        amountFils: allocationCandidateFils,
        reference: reference.trim() || null,
      };
      setAllocations((current) => addPaymentAllocation(current, next, grandTotalFils));
      if (cashChangeFils > 0) {
        toast.success(`Cash payment added · Change ${formatCurrency(filsToBhd(cashChangeFils))}`);
      }
    } catch (error: any) {
      toast.error(error.message ?? "Could not add payment allocation");
    }
  };

  const confirm = () => {
    try {
      assertAllocationsSettle(grandTotalFils, allocations);
      onConfirm(
        allocations,
        filsToBhd(tipFils),
        couponDiscountFils > 0 ? coupon.trim().toUpperCase() : undefined,
        filsToBhd(couponDiscountFils),
      );
    } catch (error: any) {
      toast.error(error.message ?? "Payment split does not settle the sale");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-[var(--g-hairline)]">
          <DialogTitle className="text-xl flex items-baseline justify-between gap-4">
            <span className="h-display text-xl">Charge sale</span>
            <div className="text-right">
              <div className="h-meta">Total payable</div>
              <div className="h-num text-3xl text-brand-600">{formatCurrency(filsToBhd(grandTotalFils))}</div>
              <div className="h-meta">Remaining {formatCurrency(filsToBhd(remainingFils))}</div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_340px] gap-0 min-h-[540px]">
          <div className="p-6 border-r border-[var(--g-hairline)] overflow-y-auto space-y-6">
            <section className="space-y-3">
              <div className="h-label uppercase tracking-widest">Payment method</div>
              <div className="grid grid-cols-2 gap-2">
                {METHODS.map((option) => {
                  const active = method === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setMethod(option.id)}
                      className={cn(
                        "flex flex-col items-center justify-center gap-2 h-20 rounded-xl border-2 transition-all active:scale-95",
                        active
                          ? "border-[var(--brand-600)] glass-strong text-[var(--ink-900)] shadow-md"
                          : "border-[var(--g-hairline)] glass text-[var(--ink-500)] hover:border-[var(--brand-600)]/40",
                      )}
                    >
                      <option.icon className="h-6 w-6" />
                      <span className="font-semibold text-sm">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="h-label uppercase tracking-widest">Payment amount</div>
                <span className="h-meta">{formatCurrency(filsToBhd(remainingFils))} remaining</span>
              </div>
              <Input
                type="number"
                min="0.001"
                step="0.001"
                value={entryAmount}
                onChange={(event) => setEntryAmount(event.target.value)}
                aria-label={method === "cash" ? "Cash received" : `${paymentMethodLabel(method)} amount`}
              />
              {method !== "cash" && (
                <Input
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder={`${paymentMethodLabel(method)} reference (optional)`}
                />
              )}
              {method === "cash" && cashChangeFils > 0 && (
                <div className="glass rounded-xl px-4 py-3 flex items-center justify-between">
                  <span className="h-label uppercase tracking-wider">Change</span>
                  <span className="h-num text-xl text-[var(--g-ok)]">{formatCurrency(filsToBhd(cashChangeFils))}</span>
                </div>
              )}
              <button
                type="button"
                className="g-btn g-btn-primary w-full"
                disabled={remainingFils <= 0 || invalidEntry}
                onClick={addAllocation}
              >
                <Plus className="h-4 w-4" /> Add {paymentMethodLabel(method)} payment
              </button>
            </section>

            <section className="space-y-3">
              <div className="h-label uppercase tracking-widest">Payment split</div>
              {allocations.length === 0 ? (
                <div className="glass-thin rounded-xl p-4 h-meta">No payment allocations added yet.</div>
              ) : (
                <div className="space-y-2">
                  {allocations.map((allocation, index) => (
                    <div key={`${allocation.method}-${allocation.reference ?? ""}-${index}`} className="glass-thin rounded-xl px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm">{paymentMethodLabel(allocation.method)}</div>
                        {allocation.reference && <div className="h-meta truncate">Ref {allocation.reference}</div>}
                      </div>
                      <div className="h-num">{formatCurrency(filsToBhd(allocation.amountFils))}</div>
                      <button
                        type="button"
                        className="g-btn g-btn-ghost g-btn-sm"
                        aria-label={`Remove ${paymentMethodLabel(allocation.method)} payment`}
                        onClick={() => setAllocations((current) => removePaymentAllocation(current, index))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <div className="flex justify-between h-meta px-1">
                    <span>Allocated</span>
                    <span>{formatCurrency(filsToBhd(allocatedFils))}</span>
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-3 pt-2">
              <div className="h-label uppercase tracking-widest flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" /> Discount coupon
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter code..."
                  value={coupon}
                  onChange={(event) => {
                    setCoupon(event.target.value.toUpperCase());
                    setCouponDiscountFils(0);
                  }}
                  className="uppercase font-mono"
                />
                <button type="button" className="g-btn g-btn-ghost px-4" onClick={applyCoupon} disabled={validatingCoupon}>
                  {validatingCoupon ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
                </button>
              </div>
              {couponDiscountFils > 0 && (
                <div className="text-xs font-semibold text-[var(--g-ok)]">
                  Discount applied: -{formatCurrency(filsToBhd(couponDiscountFils))}
                </div>
              )}
            </section>
          </div>

          <div className="p-6 glass-thin flex flex-col justify-between gap-5">
            <div className="space-y-5">
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-label uppercase tracking-widest flex items-center gap-1.5">
                    <Heart className="h-3.5 w-3.5 text-[var(--g-bad)]" /> Tip
                  </div>
                  <div className="text-sm font-bold tabular-nums text-g-bad">
                    {tipFils > 0 ? `+${formatCurrency(filsToBhd(tipFils))}` : "No tip"}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {TIP_SUGGESTIONS.map((suggestion) => {
                    const suggestedFils = percentageOfFils(discountedTotalFils, suggestion.percent);
                    return (
                      <button
                        key={suggestion.label}
                        type="button"
                        className={cn("g-pill g-pill-h28 transition-all", tipFils === suggestedFils ? "g-pill-bad" : "g-pill-ghost")}
                        onClick={() => handleTipPercent(suggestion.percent)}
                      >
                        {suggestion.label}
                      </button>
                    );
                  })}
                </div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 h-meta">BHD</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.001"
                    placeholder="Custom amount"
                    className="pl-12"
                    value={tipFils ? filsToBhd(tipFils) : ""}
                    onChange={(event) => {
                      try { setTipFils(bhdToFils(event.target.value || 0)); }
                      catch { setTipFils(0); }
                    }}
                  />
                </div>
              </section>

              <section className="space-y-3">
                <div className="h-label uppercase tracking-widest">Quick amount entry</div>
                <NumPad
                  value={entryAmount}
                  onChange={setEntryAmount}
                  shortcuts={method === "cash" ? SHORTCUTS : undefined}
                  onShortcut={(amount) => {
                    try { setEntryAmount(amountText(addFils(entryFils, bhdToFils(amount)))); }
                    catch { /* ignore invalid intermediate entry */ }
                  }}
                />
              </section>
            </div>

            <button
              type="button"
              className="g-btn g-btn-primary g-btn-touch w-full text-lg font-black shadow-lg"
              disabled={submitting || remainingFils !== 0 || allocations.length === 0}
              onClick={confirm}
            >
              {submitting
                ? <Loader2 className="h-5 w-5 animate-spin" />
                : <>COMPLETE · {formatCurrency(filsToBhd(grandTotalFils))}</>}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
