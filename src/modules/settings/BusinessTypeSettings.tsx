import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTenantContext } from "@/hooks/useTenantContext";
import { BUSINESS_MODE_INFO, BUSINESS_MODES, capabilitiesFor, type BusinessMode } from "@/lib/business-modes";
import { changeBusinessMode } from "@/lib/setupApply";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const FEATURE_LABEL: Record<string, string> = {
  tables: "tables", waiter: "waiter screen", kds: "kitchen screen", recipes: "recipes", modifiers: "modifiers",
  delivery_platforms: "Talabat & delivery", barcode_first: "barcode-first till", weighed_items: "items sold by weight",
};

export function BusinessTypeSettings() {
  const { tenantId, businessMode, hasRole } = useTenantContext();
  const qc = useQueryClient();
  const [target, setTarget] = useState<BusinessMode | null>(null);
  const [saving, setSaving] = useState(false);
  if (!hasRole("owner")) return null;

  const gained = (mode: BusinessMode) => capabilitiesFor(mode).filter((c) => !capabilitiesFor(businessMode).includes(c) && FEATURE_LABEL[c]).map((c) => FEATURE_LABEL[c]);
  const lost = (mode: BusinessMode) => capabilitiesFor(businessMode).filter((c) => !capabilitiesFor(mode).includes(c) && FEATURE_LABEL[c]).map((c) => FEATURE_LABEL[c]);

  const confirm = async () => {
    if (!tenantId || !target) return;
    setSaving(true);
    try {
      await changeBusinessMode(tenantId, target);
      await qc.invalidateQueries({ queryKey: ["my-roles"] });
      await qc.invalidateQueries();
      toast.success(`Business type changed to ${BUSINESS_MODE_INFO[target].label}`);
      setTarget(null);
    } catch (error) {
      toast.error((error as Error).message || "Could not change the business type");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass p-6 rounded-2xl max-w-2xl space-y-3" data-testid="business-type-settings">
      <Label>Business type</Label>
      <p className="text-sm text-muted-foreground">Decides which screens and till controls ZAIPOS shows. Your products, sales and reports are kept.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {BUSINESS_MODES.map((mode) => (
          <Button key={mode} type="button" variant={mode === businessMode ? "default" : "outline"} aria-pressed={mode === businessMode}
            onClick={() => mode !== businessMode && setTarget(mode)}>
            {BUSINESS_MODE_INFO[mode].label}
          </Button>
        ))}
      </div>
      <AlertDialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change to {target ? BUSINESS_MODE_INFO[target].label : ""}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {target && gained(target).length > 0 && <p>Adds: {gained(target).join(", ")}.</p>}
                {target && lost(target).length > 0 && <p>Hides: {lost(target).join(", ")}. Nothing is deleted; switching back shows them again.</p>}
                <p>Open table orders must be closed before switching to a type without tables.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={(e) => { e.preventDefault(); void confirm(); }}>Change business type</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
