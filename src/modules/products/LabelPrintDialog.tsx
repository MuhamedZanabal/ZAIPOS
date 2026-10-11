import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, Download, Tags } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { barcodeSvg, escPosLabel, pickBarcodeKind } from "@/lib/barcode";
import { translate as tx } from "@/i18n";

export interface LabelProduct {
  id: string;
  name: string;
  price: number | string | null;
  sku?: string | null;
  product_barcodes?: Array<{ barcode: string; is_primary?: boolean | null }> | null;
}

/** Primary barcode, else first barcode, else SKU (Code 128). */
export function labelCode(p: LabelProduct): string | null {
  const codes = p.product_barcodes ?? [];
  const primary = codes.find((b) => b.is_primary) ?? codes[0];
  const code = primary?.barcode?.trim() || p.sku?.trim() || "";
  return code && /^[\x20-\x7e]+$/.test(code) ? code : null;
}

const priceText = (price: LabelProduct["price"]) => `BHD ${Number(price ?? 0).toFixed(3)}`;

/** Shelf/product labels: print or save as PDF via the print dialog, or export ESC/POS for a label printer. */
export function LabelPrintDialog({ products }: { products: LabelProduct[] }) {
  const [open, setOpen] = useState(false);
  const [copies, setCopies] = useState<Record<string, number>>({});
  const labelled = useMemo(() => products.filter((p) => labelCode(p)), [products]);
  const chosen = labelled.filter((p) => (copies[p.id] ?? 0) > 0);
  const sheet = chosen.flatMap((p) => Array.from({ length: copies[p.id] }, () => p));

  const downloadEscPos = () => {
    const parts = chosen.map((p) => escPosLabel({ name: p.name, priceText: priceText(p.price), code: labelCode(p)!, copies: copies[p.id] }));
    const blob = new Blob(parts, { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `labels-${new Date().toISOString().slice(0, 10)}.escpos.bin`;
    document.body.appendChild(a); a.click(); a.remove();
    toast.success(tx("ESC/POS label file saved"));
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="print-labels">
        <Tags className="h-4 w-4 me-1" />{tx("Print labels")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{tx("Barcode labels")}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">{tx("EAN-13 is used for valid EAN codes; other barcodes and SKUs print as Code 128.")}</p>
          <div className="max-h-72 overflow-auto divide-y border rounded-md">
            {labelled.length === 0 && <p className="p-3 text-sm">{tx("No products with a barcode or SKU")}</p>}
            {labelled.map((p) => (
              <div key={p.id} className="flex items-center gap-3 p-2 text-sm">
                <span className="flex-1 truncate">{p.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{labelCode(p)} · {pickBarcodeKind(labelCode(p)!) === "ean13" ? "EAN-13" : "Code 128"}</span>
                <span className="tabular-nums w-24 text-end">{priceText(p.price)}</span>
                <Input type="number" min={0} max={100} className="w-16 h-8" aria-label={`${tx("Copies")} ${p.name}`}
                  value={copies[p.id] ?? 0} data-testid={`label-copies-${p.id}`}
                  onChange={(e) => setCopies({ ...copies, [p.id]: Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))) })} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" disabled={!chosen.length} onClick={downloadEscPos}><Download className="h-4 w-4 me-1" />{tx("ESC/POS file")}</Button>
            <Button disabled={!chosen.length} onClick={() => window.print()} data-testid="labels-print"><Printer className="h-4 w-4 me-1" />{tx("Print / Save PDF")} ({sheet.length})</Button>
          </div>
          {open && sheet.length > 0 && createPortal(
            <div className="label-print" aria-hidden="true">
              {sheet.map((p, i) => (
                <div key={`${p.id}-${i}`} className="label-print-item">
                  <div className="label-print-name">{p.name}</div>
                  <div className="label-print-price">{priceText(p.price)}</div>
                  {/* SVG is generated locally from validated ASCII and XML-escaped. */}
                  <div className="label-print-code" dangerouslySetInnerHTML={{ __html: barcodeSvg(labelCode(p)!, { moduleWidth: 2, height: 50 }) }} />
                </div>
              ))}
            </div>,
            document.body,
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
