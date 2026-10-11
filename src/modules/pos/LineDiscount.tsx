import { useState } from "react";
import { Percent } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bhdToFils, filsToBhd } from "@/lib/bahrain";
import { discountFils, type DiscountMode } from "@/lib/discounts";
import { effectiveCartUnitPrice, useCart, type CartLine } from "@/stores/cart";
import { translate as t } from "@/i18n";

/** Percent / fixed discount on one ticket line. VAT is charged on the discounted amount by the server; managers only. */
export function LineDiscount({ line }: { line: CartLine }) {
  const setDiscount = useCart((s) => s.setDiscount);
  const [mode, setMode] = useState<DiscountMode>("percent");
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const baseFils = bhdToFils(String((effectiveCartUnitPrice(line) * line.quantity).toFixed(3)));
  const apply = () => {
    const fils = discountFils(baseFils, mode, Number(value));
    setDiscount(line.id, Number(filsToBhd(fils)));
    setOpen(false); setValue("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="text-[11px] text-primary hover:underline mt-1 ms-2 inline-flex items-center gap-0.5" data-testid="line-discount">
          <Percent className="h-3 w-3" />{line.discount > 0 ? `${t("Discount")} -${filsToBhd(bhdToFils(String(line.discount.toFixed(3))))}` : t("Discount")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" variant={mode === "percent" ? "default" : "outline"} onClick={() => setMode("percent")}>%</Button>
          <Button size="sm" variant={mode === "fixed" ? "default" : "outline"} onClick={() => setMode("fixed")}>BHD</Button>
        </div>
        <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))} placeholder={mode === "percent" ? "10" : "0.500"} data-testid="line-discount-value" />
        <p className="text-[11px] text-muted-foreground">{t("Discounts need a manager. VAT is charged on the discounted price.")}</p>
        <div className="flex gap-2">
          {line.discount > 0 && <Button size="sm" variant="ghost" onClick={() => { setDiscount(line.id, 0); setOpen(false); }}>{t("Remove")}</Button>}
          <Button size="sm" className="flex-1" onClick={apply} disabled={!Number(value)} data-testid="line-discount-apply">{t("Apply")}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
