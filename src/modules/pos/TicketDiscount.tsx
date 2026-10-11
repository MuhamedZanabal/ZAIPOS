import { useState } from "react";
import { Tag } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filsToBhd } from "@/lib/bahrain";
import { type DiscountMode } from "@/lib/discounts";
import { lineGrossFils, linesWithTicketDiscount, ticketDiscountFils, useCart, type CartLine, type TicketDiscount as TicketDiscountValue } from "@/stores/cart";
import { translate as t } from "@/i18n";
import { ManagerPinDialog } from "./ManagerPinDialog";
import { useDiscountApproval } from "./useDiscountApproval";

/** The most-discounted line after applying `ticket`, as [discountFils, grossFils]. */
export function worstLineDiscount(lines: CartLine[], ticket: TicketDiscountValue | null): [number, number] {
  let worst: [number, number] = [0, 1];
  for (const line of linesWithTicketDiscount(lines, ticket)) {
    const gross = lineGrossFils(line);
    const d = Math.round(line.discount * 1000);
    if (gross > 0 && d * worst[1] > worst[0] * gross) worst = [d, gross];
  }
  return worst;
}

/** Whole-ticket percent / fixed discount, applied before VAT and spread across lines. */
export function TicketDiscount({ cashSessionId }: { cashSessionId?: string | null }) {
  const lines = useCart((s) => s.lines);
  const ticket = useCart((s) => s.ticketDiscount);
  const setTicket = useCart((s) => s.setTicketDiscount);
  const approval = useDiscountApproval();
  const [mode, setMode] = useState<DiscountMode>("percent");
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const amount = ticketDiscountFils(lines, ticket);

  const apply = () => {
    const next = { mode, value: Number(value) };
    const [d, gross] = worstLineDiscount(lines, next);
    setOpen(false);
    approval.guard(d, gross, () => { setTicket(next); setValue(""); });
  };

  if (lines.length === 0) return null;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="text-[12px] text-primary hover:underline inline-flex items-center gap-1" data-testid="ticket-discount">
            <Tag className="h-3.5 w-3.5" />
            {amount > 0 ? `${t("Ticket discount")} -${filsToBhd(amount)}` : t("Ticket discount")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-1">
            <Button size="sm" variant={mode === "percent" ? "default" : "outline"} onClick={() => setMode("percent")}>%</Button>
            <Button size="sm" variant={mode === "fixed" ? "default" : "outline"} onClick={() => setMode("fixed")}>BHD</Button>
          </div>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))} placeholder={mode === "percent" ? "10" : "1.000"} data-testid="ticket-discount-value" />
          <p className="text-[11px] text-muted-foreground">
            {t("Applied before VAT. Above")} {approval.thresholdPct}% {t("a manager PIN is required.")}
          </p>
          <div className="flex gap-2">
            {ticket && <Button size="sm" variant="ghost" onClick={() => { setTicket(null); setOpen(false); }}>{t("Remove")}</Button>}
            <Button size="sm" className="flex-1" onClick={apply} disabled={!Number(value)} data-testid="ticket-discount-apply">{t("Apply")}</Button>
          </div>
        </PopoverContent>
      </Popover>
      <ManagerPinDialog open={approval.dialogOpen} onOpenChange={(v) => { if (!v) approval.closeDialog(); }}
        tenantId={approval.tenantId} branchId={approval.branchId} cashSessionId={cashSessionId}
        onApproved={(id) => approval.approve(id)} />
    </>
  );
}
