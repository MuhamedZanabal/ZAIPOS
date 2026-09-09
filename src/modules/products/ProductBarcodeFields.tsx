import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Plus, ScanBarcode, Star, Trash2 } from "lucide-react";
import type { ProductBarcodeInspection } from "@/lib/productBarcodeCommands";
import {
  PRODUCT_BARCODE_TYPES,
  normalizeBarcode,
  type ProductBarcode,
  type ProductBarcodeType,
} from "@/lib/productBarcodes";

const TYPE_LABELS: Record<ProductBarcodeType, string> = {
  ean_8: "EAN-8",
  ean_13: "EAN-13",
  upc_a: "UPC-A",
  code_128: "Code 128",
  qr: "QR",
  internal: "Internal",
  supplier: "Supplier",
  legacy: "Legacy",
};

type Props = {
  barcodes: ProductBarcode[];
  issues: ProductBarcodeInspection[];
  scanning: boolean;
  onChange: (barcodes: ProductBarcode[]) => void;
  onStartScan: () => void;
};

export function ProductBarcodeFields({ barcodes, issues, scanning, onChange, onStartScan }: Props) {
  const update = (index: number, patch: Partial<ProductBarcode>) => {
    onChange(barcodes.map((entry, current) => current === index ? { ...entry, ...patch } : entry));
  };
  const remove = (index: number) => {
    const next = barcodes.filter((_, current) => current !== index);
    if (next.length > 0 && !next.some((entry) => entry.is_primary)) next[0] = { ...next[0], is_primary: true };
    onChange(next);
  };
  const makePrimary = (index: number) => {
    onChange(barcodes.map((entry, current) => ({ ...entry, is_primary: current === index })));
  };
  const add = () => onChange([
    ...barcodes,
    { barcode: "", barcode_type: "code_128", is_primary: barcodes.length === 0 },
  ]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>Product barcodes</Label>
          <p className="text-xs text-muted-foreground">Add retail, case, supplier, or internal codes. One code must be primary.</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onStartScan} disabled={scanning}>
            <ScanBarcode className="h-4 w-4 mr-1" />{scanning ? "Waiting…" : "Scan"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={add}>
            <Plus className="h-4 w-4 mr-1" />Add code
          </Button>
        </div>
      </div>

      {barcodes.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground text-center">No barcode assigned.</div>
      ) : barcodes.map((entry, index) => {
        const issue = issues.find((candidate) => candidate.input_index === index && candidate.state !== "valid");
        return (
          <div key={`${index}-${entry.barcode}`} className="space-y-1.5 rounded-lg border p-3">
            <div className="grid grid-cols-[1fr_150px_auto_auto] items-center gap-2">
              <Input
                aria-label={`Barcode ${index + 1}`}
                className="font-mono"
                placeholder="Type or scan a code"
                value={entry.barcode}
                onBlur={() => update(index, { barcode: normalizeBarcode(entry.barcode) })}
                onChange={(event) => update(index, { barcode: event.target.value })}
              />
              <Select value={entry.barcode_type} onValueChange={(value) => update(index, { barcode_type: value as ProductBarcodeType })}>
                <SelectTrigger aria-label={`Barcode type ${index + 1}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRODUCT_BARCODE_TYPES.filter((type) => type !== "legacy" || entry.barcode_type === "legacy").map((type) => (
                    <SelectItem key={type} value={type}>{TYPE_LABELS[type]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant={entry.is_primary ? "default" : "outline"}
                size="icon"
                onClick={() => makePrimary(index)}
                title={entry.is_primary ? "Primary barcode" : "Make primary"}
                aria-label={entry.is_primary ? "Primary barcode" : `Make barcode ${index + 1} primary`}
              >
                <Star className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} aria-label={`Remove barcode ${index + 1}`}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {issue && (
              <div className="flex items-start gap-2 text-xs text-destructive" role="alert">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  {issue.state === "malformed" && "This barcode format is invalid for the selected type."}
                  {issue.state === "duplicate_input" && "This barcode appears more than once in this product."}
                  {issue.state === "database_conflict" && `Already assigned to ${issue.conflicting_product_name ?? "another product"}. Change or remove it before saving.`}
                  {issue.state === "retired_product_conflict" && `Assigned to retired product ${issue.conflicting_product_name ?? "unknown"}. Review that product before reassigning the code.`}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
