-- Qualify supplier statement references that collide with PL/pgSQL output names.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_supplier_statement_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid
)
RETURNS TABLE(
  entry_id uuid,
  entry_type text,
  occurred_at timestamptz,
  amount_fils bigint,
  balance_delta_fils bigint,
  running_balance_fils bigint,
  purchase_order_id uuid,
  payment_method text,
  payment_reference text,
  note text,
  coverage_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _has_opening boolean;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _actor_id,_tenant_id,_branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.suppliers s
    WHERE s.tenant_id=_tenant_id AND s.id=_supplier_id
  ) THEN
    RAISE EXCEPTION 'Supplier does not belong to tenant';
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM public.supplier_ledger_entries e
    WHERE e.tenant_id=_tenant_id
      AND e.branch_id=_branch_id
      AND e.supplier_id=_supplier_id
      AND e.entry_type='opening_balance'
  ) INTO _has_opening;

  RETURN QUERY
  WITH ordered AS (
    SELECT e.*,
      CASE WHEN e.entry_type='payment' THEN -e.amount_fils ELSE e.amount_fils END AS delta
    FROM public.supplier_ledger_entries e
    WHERE e.tenant_id=_tenant_id
      AND e.branch_id=_branch_id
      AND e.supplier_id=_supplier_id
  )
  SELECT
    o.id,
    o.entry_type,
    o.occurred_at,
    o.amount_fils,
    o.delta,
    sum(o.delta) OVER (ORDER BY o.occurred_at,o.id ROWS UNBOUNDED PRECEDING)::bigint,
    o.purchase_order_id,
    o.payment_method,
    o.payment_reference,
    o.note,
    CASE WHEN _has_opening THEN 'complete_from_cutover' ELSE 'opening_balance_required' END
  FROM ordered o
  ORDER BY o.occurred_at,o.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_supplier_statement_v1(uuid,uuid,uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_supplier_statement_v1(uuid,uuid,uuid)
TO authenticated;

COMMIT;
