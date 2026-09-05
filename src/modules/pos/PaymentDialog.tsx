import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import { Banknote, CreditCard, Smartphone, QrCode, Loader2, Heart, Tag, X } from "lucide-react";
import { NumPad } from "./NumPad";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  BHD_CASH_SHORTCUTS,
  bhdToFils,
  filsToBhd,
  formatFils,
  roundBhd,
  subtractMoney,
} from "@/lib/bahrain";
import {
  addPaymentAllocation,
  remainingPaymentFils,
  type PaymentAllocation,
  type PayMethod,
} from "./paymentAllocations";

/**
 * Database-compatible payment buckets.
 * `qr` is the Bahrain BenefitPay bucket and `transfer` is Bank Transfer.
 * Keeping these storage values preserves cash-session and historical-report compatibility.
 */
export type { PayMethod } from "./paymentAllocations";

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
  onOpenChange: (o: boolean) => void;
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
  { label: "0%", value: 0 },
  { label: "5%", percent: 0.05 },
  { label: "10%", percent: 0.1 },
  { label: "15%", percent: 0.15 },
];

const SHORTCUTS = [...BHD_CASH_SHORTCUTS];
const amountText = (value: number) => roundBhd(value).toFixed(3);

export function PaymentDialog({ open, onOpenChange, total, tenantId, submitting, onConfirm }: PaymentDialogProps) {
  const [method, setMethod] = useState<PayMethod>("cash");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [allocations, setAllocations] = useState<PaymentAllocation[]>([]);
  const [tip, setTip] = useState(0);
  const [coupon, setCoupon] = useState("");
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [validatingCoupon, setValidatingCoupon] = useState(false);

  const discountedTotal = roundBhd(Math.max(0, total - couponDiscount));
  const grandTotal = roundBhd(discountedTotal + tip);
  const payableFils = bhdToFils(amountText(grandTotal));
  const remainingFils = remainingPaymentFils(payableFils, allocations);
  const allocatedFils = subtractMoney(payableFils, remainingFils);
  const paymentAmountFils = useMemo(() => {
    try {
      return bhdToFils(paymentAmount || "0");
    } catch {
      return 0;
    }
  }, [paymentAmount]);
  const previewCashChangeFils = method === "cash"
    ? Math.max(0, paymentAmountFils - remainingFils)
    : 0;
  const totalsLocked = allocations.length > 0;

  useEffect(() => {
    if (!open) return;
    setMethod("cash");
    setAllocations([]);
    setTip(0);
    setCoupon("");
    setCouponDiscount(0);
    setPaymentAmount(amountText(total));
  }, [open, total]);

  useEffect(() => {
    if (!open || totalsLocked) return;
    setPaymentAmount(filsToBhd(payableFils));
  }, [open, payableFils, totalsLocked]);

  const handleTipPercent = (percent: number) => {
    if (totalsLocked) return;
    setTip(roundBhd(discountedTotal * percent));
  };

  const applyCoupon = async () => {
    if (totalsLocked) return;
    const code = coupon.trim().toUpperCase();
    if (!code) {
      setCouponDiscount(0);
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
        setCouponDiscount(0);
        return toast.error("Invalid or expired coupon");
      }

      if (data.max_uses != null && Number(data.current_uses) >= Number(data.max_uses)) {
        setCouponDiscount(0);
        return toast.error("Coupon has no remaining uses");
      }

      const rawDiscount = data.discount_type === "percentage"
        ? total * (Number(data.discount_value) / 100)
        : Number(data.discount_value);
      const discount = roundBhd(Math.min(total, Math.max(0, rawDiscount)));

      setCouponDiscount(discount);
      toast.success(`Coupon applied · -${formatCurrency(discount)}`);
    } catch (error: any) {
      toast.error(error.message ?? "Could not validate the coupon");
    } finally {
      setValidatingCoupon(false);
    }
  };

  const selectMethod = (nextMethod: PayMethod) => {
    setMethod(nextMethod);
    setPaymentAmount(filsToBhd(remainingFils));
  };

  const addAllocation = () => {
    try {
      const tenderedFils = bhdToFils(paymentAmount);
      const next = addPaymentAllocation(payableFils, allocations, method, tenderedFils);
      setAllocations(next.allocations);
      setPaymentAmount(next.remainingFils > 0 ? filsToBhd(next.remainingFils) : "0.000");
    } catch (error: any) {
      toast.error(error?.message ?? "Could not add payment");
    }
  };

  const removeAllocation = (index: number) => {
    const next = allocations.filter((_, allocationIndex) => allocationIndex !== index);
    setAllocations(next);
    const nextRemaining = remainingPaymentFils(payableFils, next);
    setPaymentAmount(filsToBhd(nextRemaining));
  };

  const completeSale = () => {
    if (remainingFils !== 0 || allocations.length === 0) return;
    onConfirm(
      allocations,
      tip,
      couponDiscount > 0 ? coupon.trim().toUpperCase() : undefined,
      couponDiscount,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-[var(--g-hairline)]">
          <DialogTitle className="text-xl flex items-baseline justify-between">
            <span className="h-display text-xl">Charge sale</span>
            <div className="text-right">
              <div className="h-meta">Total payable, including tip</div>
              <div className="h-num text-3xl text-brand-600">{formatCurrency(grandTotal)}</div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_340px] gap-0 min-h-[560px] max-h-[78vh]">
          <div className="p-6 border-r border-[var(--g-hairline)] overflow-y-auto space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="glass rounded-xl px-4 py-3">
                <div className="h-label uppercase tracking-widest mb-1">Allocated</div>
                <div className="h-num text-2xl">{formatFils(allocatedFils)}</div>
              </div>
              <div className="glass rounded-xl px-4 py-3">
                <div className="h-label uppercase tracking-widest mb-1">Remaining</div>
                <div className={cn("h-num text-2xl", remainingFils === 0 && "text-[var(--g-ok)]")}>{formatFils(remainingFils)}</div>
              </div>
            </div>

            {allocations.length > 0 && (
              <div className="space-y-2">
                <div className="h-label uppercase tracking-widest">Payment allocations</div>
                {allocations.map((allocation, index) => {
                  const label = paymentMethodLabel(allocation.method);
                  return (
                    <div key={`${allocation.method}-${index}`} className="glass rounded-xl px-3 py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{label} · {formatFils(allocation.amountFils)}</div>
                        {allocation.changeFils > 0 && (
                          <div className="text-xs font-semibold text-[var(--g-ok)]">Change · {formatFils(allocation.changeFils)}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${label} payment`}
                        className="g-btn g-btn-ghost h-8 w-8 p-0 shrink-0"
                        onClick={() => removeAllocation(index)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="space-y-3">
              <div className="h-label uppercase tracking-widest">Payment method</div>
              <div className="grid grid-cols-2 gap-2">
                {METHODS.map((option) => {
                  const active = method === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => selectMethod(option.id)}
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
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="h-label uppercase tracking-widest flex items-center gap-1.5">
                  <Heart className="h-3.5 w-3.5 text-[var(--g-bad)]" /> Tip
                </div>
                <div className="text-sm font-bold tabular-nums text-g-bad">
                  {tip > 0 ? "+" + formatCurrency(tip) : "No tip"}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {TIP_SUGGESTIONS.map((suggestion) => {
                  const suggestedAmount = suggestion.percent
                    ? roundBhd(discountedTotal * suggestion.percent)
                    : suggestion.value;
                  const isActive = tip === suggestedAmount;
                  return (
                    <button
                      key={suggestion.label}
                      type="button"
                      disabled={totalsLocked}
                      className={cn("g-pill g-pill-h28 transition-all", isActive ? "g-pill-bad" : "g-pill-ghost")}
                      onClick={() => suggestion.percent !== undefined
                        ? handleTipPercent(suggestion.percent)
                        : setTip(suggestion.value)}
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
                  value={tip || ""}
                  disabled={totalsLocked}
                  onChange={(e) => setTip(roundBhd(Number(e.target.value) || 0))}
                />
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <div className="h-label uppercase tracking-widest flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" /> Discount coupon
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter code..."
                  value={coupon}
                  disabled={totalsLocked}
                  onChange={(e) => {
                    setCoupon(e.target.value.toUpperCase());
                    setCouponDiscount(0);
                  }}
                  className="uppercase font-mono"
                />
                <button
                  type="button"
                  className="g-btn g-btn-ghost px-4"
                  onClick={applyCoupon}
                  disabled={validatingCoupon || totalsLocked}
                >
                  {validatingCoupon ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
                </button>
              </div>
              {couponDiscount > 0 && (
                <div className="text-xs font-semibold text-[var(--g-ok)]">
                  Discount applied: -{formatCurrency(couponDiscount)}
                </div>
              )}
              {totalsLocked && (
                <div className="text-xs text-muted-foreground">Remove payments to edit tip or coupon.</div>
              )}
            </div>
          </div>

          <div className="p-6 glass-thin flex flex-col justify-between overflow-y-auto">
            <div className="space-y-4">
              <div className="glass rounded-xl px-4 py-3">
                <div className="h-label uppercase tracking-widest mb-1">{paymentMethodLabel(method)} amount</div>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  aria-label="Payment amount"
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                  className="h-num text-2xl"
                  disabled={remainingFils === 0}
                />
              </div>

              <NumPad
                value={paymentAmount}
                onChange={setPaymentAmount}
                shortcuts={method === "cash" ? SHORTCUTS : undefined}
                onShortcut={(amount) => setPaymentAmount(amountText((Number(paymentAmount) || 0) + amount))}
              />

              {method === "cash" && previewCashChangeFils > 0 && remainingFils > 0 && (
                <div className="glass rounded-xl px-4 py-3 flex items-center justify-between">
                  <span className="h-label uppercase tracking-wider">Change</span>
                  <span className="h-num text-xl text-[var(--g-ok)]">{formatFils(previewCashChangeFils)}</span>
                </div>
              )}

              <button
                type="button"
                className="g-btn g-btn-ghost g-btn-touch w-full font-bold"
                disabled={submitting || remainingFils === 0}
                onClick={addAllocation}
              >
                Add {paymentMethodLabel(method)} payment
              </button>
            </div>

            <button
              type="button"
              className="g-btn g-btn-primary g-btn-touch w-full text-lg font-black shadow-lg mt-4"
              disabled={submitting || allocations.length === 0 || remainingFils !== 0}
              onClick={completeSale}
            >
              {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : "Complete sale"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
