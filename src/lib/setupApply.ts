/**
 * Writes the in-app wizard steps (catalog, payments, staff, progress) through
 * the normal client, so the same code runs against the hosted backend and the
 * local service. Every step is safe to re-run: a resumed wizard won't duplicate
 * categories, products, opening stock or staff.
 */
import { supabase } from "@/integrations/supabase/client";
import { recordInventoryBatchV2 } from "@/lib/inventory";
import { replaceProductBarcodes } from "@/lib/productBarcodeCommands";
import type { SetupStatus, StaffDraft, StarterItem, WizardState } from "@/lib/setupWizard";

const db = supabase as any;
export const SAMPLE_OPENING_STOCK = 50;

async function readReceiptConfig(tenantId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("tenants").select("receipt_config").eq("id", tenantId).maybeSingle();
  if (error) throw error;
  return (data?.receipt_config as Record<string, unknown> | null) ?? {};
}

async function patchTenant(tenantId: string, patch: Record<string, unknown>, receiptPatch?: Record<string, unknown>) {
  const update: Record<string, unknown> = { ...patch };
  if (receiptPatch) update.receipt_config = { ...(await readReceiptConfig(tenantId)), ...receiptPatch };
  const { error } = await db.from("tenants").update(update).eq("id", tenantId);
  if (error) throw error;
}

export function setSetupStatus(tenantId: string, status: SetupStatus) {
  return patchTenant(tenantId, {}, { setup: status });
}

/** Basics that the bootstrap call doesn't take (VAT rate, TRN). */
export function saveBasics(tenantId: string, state: WizardState, nextStep: number) {
  return patchTenant(
    tenantId,
    { tax_rate: state.basics.vatRate, currency: "BHD" },
    { trn: state.basics.trn.trim() || null, setup: { status: "in_progress", step: nextStep } },
  );
}

async function ensureInventoryCenter(tenantId: string, branchId: string): Promise<string> {
  const { data, error } = await db.from("inventory_centers").select("id").eq("tenant_id", tenantId).eq("branch_id", branchId).limit(1);
  if (error) throw error;
  if (data?.[0]?.id) return data[0].id;
  const { data: created, error: insertError } = await db
    .from("inventory_centers")
    .insert([{ tenant_id: tenantId, branch_id: branchId, name: "Main store", type: "point_of_sale", status: "active" }])
    .select("id")
    .single();
  if (insertError) throw insertError;
  return created.id;
}

export async function applyStarterCatalog(tenantId: string, branchId: string, vatRate: number, items: StarterItem[]) {
  const chosen = items.filter((item) => item.include && item.name.trim());
  if (chosen.length === 0) return { products: 0 };

  const { data: existingCategories, error: categoryError } = await db.from("categories").select("id, name").eq("tenant_id", tenantId);
  if (categoryError) throw categoryError;
  const categoryIds = new Map<string, string>((existingCategories ?? []).map((c: { id: string; name: string }) => [c.name, c.id]));
  const missing = [...new Set(chosen.map((item) => item.category))].filter((name) => !categoryIds.has(name));
  if (missing.length) {
    const { data, error } = await db
      .from("categories")
      .insert(missing.map((name, index) => ({ tenant_id: tenantId, name, sort_order: index })))
      .select("id, name");
    if (error) throw error;
    (data ?? []).forEach((c: { id: string; name: string }) => categoryIds.set(c.name, c.id));
  }

  const { data: existingProducts, error: productError } = await db.from("products").select("id, name").eq("tenant_id", tenantId);
  if (productError) throw productError;
  const productIds = new Map<string, string>((existingProducts ?? []).map((p: { id: string; name: string }) => [p.name, p.id]));
  const toInsert = chosen.filter((item) => !productIds.has(item.name.trim()));
  if (toInsert.length) {
    const { data, error } = await db
      .from("products")
      .insert(toInsert.map((item) => ({
        tenant_id: tenantId,
        category_id: categoryIds.get(item.category) ?? null,
        name: item.name.trim(),
        product_type: "simple",
        unit_code: item.unit,
        price: item.price,
        cost: 0,
        tax_rate: vatRate,
        min_stock: 0,
        status: "active",
        description: "Sample item from setup. Edit or delete it any time.",
      })))
      .select("id, name");
    if (error) throw error;
    (data ?? []).forEach((p: { id: string; name: string }) => productIds.set(p.name, p.id));
    for (const item of toInsert) {
      const id = productIds.get(item.name.trim());
      if (id && item.barcode) {
        await replaceProductBarcodes(tenantId, id, [{ barcode: item.barcode, barcode_type: "ean_13", is_primary: true }], `setup-barcode-${id}` as Parameters<typeof replaceProductBarcodes>[3]);
      }
    }
  }

  // Opening stock so the first test sale isn't blocked. Idempotent per product.
  const centerId = await ensureInventoryCenter(tenantId, branchId);
  const ids = chosen.map((item) => productIds.get(item.name.trim())).filter(Boolean) as string[];
  const { data: stocks } = await db.from("inventory_stocks").select("product_id, quantity").eq("branch_id", branchId).in("product_id", ids);
  const stocked = new Set((stocks ?? []).filter((s: { quantity: number }) => Number(s.quantity) > 0).map((s: { product_id: string }) => s.product_id));
  const movements = ids.filter((id) => !stocked.has(id)).map((productId) => ({
    productId,
    type: "purchase" as const,
    quantity: SAMPLE_OPENING_STOCK,
    effectKey: `opening-${productId}`,
  }));
  if (movements.length) {
    await recordInventoryBatchV2({
      tenantId,
      branchId,
      inventoryCenterId: centerId,
      clientMutationId: `setup-opening-stock-${tenantId}-${movements.length}-${ids.length}`,
      movements,
      reason: "Opening stock for setup sample items",
    });
  }
  return { products: ids.length };
}

export function savePaymentsAndReceipt(tenantId: string, state: WizardState, nextStep: number) {
  return patchTenant(tenantId, {}, {
    payment_methods: state.payments.methods,
    header_text: state.payments.receiptHeader,
    footer_text: state.payments.receiptFooter,
    setup: { status: "in_progress", step: nextStep },
  });
}

export async function createStaff(tenantId: string, branchId: string, staff: StaffDraft[]) {
  const created: string[] = [];
  for (const member of staff) {
    const { data, error } = await supabase.functions.invoke("create-user", {
      body: {
        email: member.email.trim().toLowerCase(),
        password: member.password,
        full_name: member.name.trim() || member.email.trim(),
        role: member.role,
        tenant_id: tenantId,
        branch_id: branchId,
      },
    });
    const message = (error as { message?: string } | null)?.message ?? (data as { error?: string } | null)?.error;
    if (message && !/already in use|already registered|already exists/i.test(message)) throw new Error(`${member.email}: ${message}`);
    created.push(member.email);
  }
  return created;
}

/** Owner-only business type change (Settings). */
export async function changeBusinessMode(tenantId: string, mode: string) {
  const { data, error } = await (supabase.rpc as any)("change_business_mode_v1", { _tenant_id: tenantId, _business_mode: mode });
  if (error) throw error;
  return data as string;
}
