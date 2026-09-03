import { useState } from "react";
import { lookupEAN, type BarcodeProduct } from "@/lib/barcodeLookup";
import { toast } from "sonner";

export function useBarcodeLookup() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BarcodeProduct | null>(null);

  async function lookup(barcode: string): Promise<BarcodeProduct | null> {
    if (!barcode.trim()) return null;
    setLoading(true);
    try {
      const product = await lookupEAN(barcode.trim());
      setResult(product);
      if (!product) toast.info("Code not found in the global database.");
      return product;
    } catch (err: any) {
      toast.error(err.message ?? "Error querying the barcode API.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  function clear() { setResult(null); }

  return { lookup, loading, result, clear };
}
