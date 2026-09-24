-- P0: retire the legacy cart-to-table boundary.
--
-- This SECURITY DEFINER function accepted tenant, branch, waiter, price, tax,
-- discount and line totals from the renderer. Tenant membership alone was
-- therefore sufficient to manufacture authoritative restaurant accounting.
-- Existing persisted queue records must be quarantined by the client cutover;
-- they cannot be safely translated because their financial fields are not
-- authoritative.

BEGIN;

REVOKE ALL ON FUNCTION public.upsert_table_order_items(uuid,uuid,uuid,uuid,jsonb,text)
FROM PUBLIC, anon, authenticated;

COMMIT;
