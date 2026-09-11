import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createProductMergeOperationId,
  mergeDuplicateProduct,
  previewProductMerge,
  type ProductMergePreview,
} from "@/lib/productMergeCommands";

type MergeProduct = {
  id: string;
  name: string;
  sku?: string | null;
  status?: string | null;
};

type ProductMergeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  sourceProduct: MergeProduct;
  products: MergeProduct[];
  onMerged: () => void | Promise<void>;
};

const blockerLabels: Record<string, string> = {
  held_cart: "held cart",
  held_carts: "held cart",
  production: "production order",
  production_order: "production order",
  production_orders: "production order",
  price_override: "price override",
  price_override_requests: "price override",
  modifier_groups: "modifier group",
  pricing_policy_rules: "pricing policy rule",
  product_complementaries: "complementary product relationship",
  product_components: "product component / BOM relationship",
};

function blockerLabel(blocker: string) {
  return blockerLabels[blocker] ?? blocker.replaceAll("_", " ");
}

export function ProductMergeDialog({
  open,
  onOpenChange,
  tenantId,
  sourceProduct,
  products,
  onMerged,
}: ProductMergeDialogProps) {
  const [canonicalProductId, setCanonicalProductId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<ProductMergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [merging, setMerging] = useState(false);

  const candidates = useMemo(
    () => products.filter((product) => product.id !== sourceProduct.id && product.status === "active"),
    [products, sourceProduct.id],
  );

  useEffect(() => {
    if (!open) {
      setCanonicalProductId("");
      setReason("");
      setConfirmation("");
      setPreview(null);
      setError(null);
      setReviewing(false);
      setMerging(false);
    }
  }, [open]);

  const selectCanonical = (value: string) => {
    setCanonicalProductId(value);
    setPreview(null);
    setConfirmation("");
    setError(null);
  };

  const reviewMerge = async () => {
    if (!canonicalProductId || reviewing) return;
    setReviewing(true);
    setError(null);
    setPreview(null);
    try {
      const nextPreview = await previewProductMerge(tenantId, sourceProduct.id, canonicalProductId);
      setPreview(nextPreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to review this merge.");
    } finally {
      setReviewing(false);
    }
  };

  const canCommit = Boolean(
    preview?.can_merge &&
      preview.canonical_product_id === canonicalProductId &&
      reason.trim().length >= 10 &&
      confirmation === "MERGE" &&
      !merging,
  );

  const commitMerge = async () => {
    if (!canCommit) return;
    setMerging(true);
    setError(null);
    try {
      await mergeDuplicateProduct(
        tenantId,
        sourceProduct.id,
        canonicalProductId,
        reason.trim(),
        createProductMergeOperationId(),
      );
      await onMerged();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to merge this product.");
    } finally {
      setMerging(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Merge duplicate product</DialogTitle>
          <DialogDescription>
            Preserve historical evidence while consolidating current stock and barcode identity. The source product is retained as an inactive alias.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">Source product</div>
            <div>{sourceProduct.name}</div>
            {sourceProduct.sku ? <div className="text-muted-foreground">SKU {sourceProduct.sku}</div> : null}
          </div>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Canonical product</span>
            <select
              aria-label="Canonical product"
              className="w-full rounded-md border bg-background px-3 py-2"
              value={canonicalProductId}
              onChange={(event) => selectCanonical(event.target.value)}
              disabled={reviewing || merging}
            >
              <option value="">Select the product to keep</option>
              {candidates.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}{product.sku ? ` — ${product.sku}` : ""}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={reviewMerge}
            disabled={!canonicalProductId || reviewing || merging}
          >
            {reviewing ? "Reviewing…" : "Review merge"}
          </button>

          {preview ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="font-medium">Authoritative preview</div>
              <div className="grid grid-cols-2 gap-2">
                <span>Source stock</span><span>{preview.source_stock_quantity}</span>
                <span>Canonical stock</span><span>{preview.canonical_stock_quantity}</span>
                <span>Combined stock</span><span>{preview.combined_stock_quantity}</span>
              </div>
              <div>{preview.source_barcode_count} source barcodes will resolve to the canonical product.</div>
              {!preview.can_merge ? (
                <div role="alert" className="rounded-md border p-2">
                  Merge blocked: {preview.blockers.map(blockerLabel).join(", ")}. Resolve these live references and review again.
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <div role="alert" className="rounded-md border p-2 text-sm">{error}</div> : null}

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Merge reason</span>
            <input
              aria-label="Merge reason"
              className="w-full rounded-md border bg-background px-3 py-2"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={merging}
              placeholder="Describe how the duplicate was verified"
            />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">Type MERGE to confirm</span>
            <input
              aria-label="Type MERGE to confirm"
              className="w-full rounded-md border bg-background px-3 py-2 font-mono"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={merging}
              autoComplete="off"
            />
          </label>
        </div>

        <DialogFooter>
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-sm"
            onClick={() => onOpenChange(false)}
            disabled={merging}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
            onClick={commitMerge}
            disabled={!canCommit}
          >
            {merging ? "Merging…" : "Merge duplicate"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
