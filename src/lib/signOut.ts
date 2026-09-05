import { supabase } from "@/integrations/supabase/client";
import { useTenantStore } from "@/stores/tenant";
import { queryClient } from "@/lib/queryClient";
import { db } from "@/lib/db";
import { clear as idbClear } from "idb-keyval";
import { logger } from "@/lib/logger";

/**
 * Signs out and clears tenant-readable caches.
 *
 * The tenant-scoped sync queue is intentionally retained. Removing it could
 * discard a financially committed checkout whose response was lost. Queue
 * readers and replay are tenant-filtered, so a later user cannot see or submit
 * another tenant's retained operations.
 */
export async function signOutFully() {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    logger.error("signout_supabase_failed", { error: String(err) });
  }

  try {
    useTenantStore.setState({ tenantId: null, branchId: null });
  } catch (err) {
    logger.error("signout_tenant_store_failed", { error: String(err) });
  }

  try {
    queryClient.clear();
  } catch (err) {
    logger.error("signout_query_clear_failed", { error: String(err) });
  }

  try {
    await Promise.all([
      db.products.clear(),
      db.categories.clear(),
      db.branch_products.clear(),
    ]);
  } catch (err) {
    logger.error("signout_dexie_clear_failed", { error: String(err) });
  }

  try {
    await idbClear();
  } catch (err) {
    logger.error("signout_idb_clear_failed", { error: String(err) });
  }
}
