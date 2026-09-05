import { useRef, useState } from "react";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { createInventoryMutationId, transferInventoryV2 } from "@/lib/inventory";

export function TransferDialog({ tenantId, branchId, userId: _userId, products, centers, onClose }: any) {
  const [productId, setProductId] = useState<string>("");
  const [fromCenterId, setFromCenterId] = useState<string>("");
  const [toCenterId, setToCenterId] = useState<string>("");
  const [qty, setQty] = useState("");
  const [saving, setSaving] = useState(false);
  const mutationId = useRef<string | null>(null);

  const resetMutation = () => {
    mutationId.current = null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fromCenterId === toCenterId) {
      toast.error("Source and destination centers must be different");
      return;
    }

    setSaving(true);
    try {
      if (!mutationId.current) mutationId.current = createInventoryMutationId("inventory-transfer");
      await transferInventoryV2({
        tenantId,
        branchId,
        productId,
        fromCenterId,
        toCenterId,
        quantity: Number(qty),
        reason: `Transfer ${centers.find((c: any) => c.id === fromCenterId)?.name} → ${centers.find((c: any) => c.id === toCenterId)?.name}`,
        clientMutationId: mutationId.current,
      });

      toast.success("Transfer completed");
      resetMutation();
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-primary" />
          Transfer Stock
        </DialogTitle>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Product</Label>
          <Select value={productId} onValueChange={(value) => { resetMutation(); setProductId(value); }}>
            <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
            <SelectContent>
              {products.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={fromCenterId} onValueChange={(value) => { resetMutation(); setFromCenterId(value); }}>
              <SelectTrigger><SelectValue placeholder="From..." /></SelectTrigger>
              <SelectContent>
                {centers.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Destination</Label>
            <Select value={toCenterId} onValueChange={(value) => { resetMutation(); setToCenterId(value); }}>
              <SelectTrigger><SelectValue placeholder="To..." /></SelectTrigger>
              <SelectContent>
                {centers.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Quantity</Label>
          <Input type="number" step="0.001" required value={qty} onChange={(e) => { resetMutation(); setQty(e.target.value); }} placeholder="0.000" className="h-12 text-lg" />
        </div>

        <Button type="submit" className="w-full h-12" disabled={saving || !productId || !qty || !fromCenterId || !toCenterId}>
          {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processing...</> : "Transfer"}
        </Button>
      </form>
    </DialogContent>
  );
}
