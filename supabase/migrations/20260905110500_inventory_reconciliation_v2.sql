-- ZAIPOS P0 inventory hardening: server-authoritative physical stock reconciliation.
--
-- Bulk physical-count imports submit target levels, never client-computed deltas.
-- The server locks each stock row, computes the signed correction from current
-- committed stock, records one adjustment movement, and binds the entire import
-- to the inventory operation ledger for replay safety.

BEGIN;

CREATE OR REPLACE FUNCTION public.reconcile_inventory_levels_v2(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _targets jsonb,
  _client_mutation_id text,
  _reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request jsonb;
  _claim record;
  _operation_id uuid;
  _item jsonb;
  _product_id uuid;
  _target_quantity numeric;
  _current_quantity numeric;
  _delta numeric;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.branches
    WHERE id = _branch_id
      AND tenant_id = _tenant_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Inventory branch is invalid or inactive';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.inventory_centers
    WHERE id = _inventory_center_id
      AND tenant_id = _tenant_id
      AND branch_id = _branch_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Inventory center is invalid or inactive';
  END IF;

  IF _targets IS NULL
     OR jsonb_typeof(_targets) <> 'array'
     OR jsonb_array_length(_targets) = 0
  THEN
    RAISE EXCEPTION 'Inventory reconciliation must contain at least one target';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_targets) item
    WHERE NULLIF(trim(COALESCE(item->>'effect_key', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Every inventory reconciliation target requires an effect key';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_targets) item
    WHERE NULLIF(trim(COALESCE(item->>'product_id', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Every inventory reconciliation target requires a product ID';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(_targets)) <>
     (SELECT count(DISTINCT item->>'effect_key') FROM jsonb_array_elements(_targets) item)
  THEN
    RAISE EXCEPTION 'Inventory reconciliation effect keys must be unique';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(_targets)) <>
     (SELECT count(DISTINCT item->>'product_id') FROM jsonb_array_elements(_targets) item)
  THEN
    RAISE EXCEPTION 'Inventory reconciliation products must be unique';
  END IF;

  _request := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'inventory_center_id', _inventory_center_id,
    'targets', _targets,
    'reason', NULLIF(trim(COALESCE(_reason, '')), '')
  );

  SELECT * INTO _claim
  FROM public.claim_inventory_operation_v2(
    _tenant_id,
    _branch_id,
    'inventory_reconcile',
    _client_mutation_id,
    _request
  );
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN
    RETURN _operation_id;
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_targets)
  LOOP
    BEGIN
      _product_id := (_item->>'product_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Inventory reconciliation product ID is invalid';
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM public.products
      WHERE id = _product_id
        AND tenant_id = _tenant_id
        AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Inventory reconciliation product is invalid or inactive';
    END IF;

    BEGIN
      _target_quantity := (_item->>'target_quantity')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Inventory target quantity must be a valid number';
    END;

    IF _target_quantity IS NULL
       OR _target_quantity < 0
       OR _target_quantity <> round(_target_quantity, 3)
    THEN
      RAISE EXCEPTION 'Inventory target quantity must be non-negative with at most three decimal places';
    END IF;

    INSERT INTO public.inventory_stocks (
      tenant_id,
      branch_id,
      inventory_center_id,
      product_id,
      quantity
    )
    VALUES (
      _tenant_id,
      _branch_id,
      _inventory_center_id,
      _product_id,
      0
    )
    ON CONFLICT (inventory_center_id, product_id) DO NOTHING;

    SELECT quantity INTO _current_quantity
    FROM public.inventory_stocks
    WHERE inventory_center_id = _inventory_center_id
      AND product_id = _product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not lock inventory stock row for reconciliation';
    END IF;

    _delta := _target_quantity - _current_quantity;

    IF _delta <> 0 THEN
      UPDATE public.inventory_stocks
      SET quantity = _target_quantity,
          updated_at = now()
      WHERE inventory_center_id = _inventory_center_id
        AND product_id = _product_id;

      INSERT INTO public.inventory_movements (
        tenant_id,
        branch_id,
        inventory_center_id,
        product_id,
        movement_type,
        quantity,
        reason,
        reference_type,
        reference_id,
        user_id
      )
      VALUES (
        _tenant_id,
        _branch_id,
        _inventory_center_id,
        _product_id,
        'adjustment'::public.movement_type,
        _delta,
        COALESCE(NULLIF(trim(COALESCE(_reason, '')), ''), 'Physical inventory reconciliation'),
        'inventory_operation',
        _operation_id,
        _user_id
      );
    END IF;
  END LOOP;

  UPDATE public.inventory_operations
  SET status = 'completed',
      completed_at = now()
  WHERE id = _operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.audit_logs (tenant_id,user_id,action,entity,entity_id,metadata) VALUES ($1,$2,$3,$4,$5,$6)'
    USING
      _tenant_id,
      _user_id,
      'inventory.reconcile_v2',
      'inventory_operations',
      _operation_id,
      jsonb_build_object(
        'branch_id', _branch_id,
        'inventory_center_id', _inventory_center_id,
        'target_count', jsonb_array_length(_targets),
        'client_mutation_id', _client_mutation_id
      );
  END IF;

  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_inventory_levels_v2(uuid,uuid,uuid,jsonb,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_inventory_levels_v2(uuid,uuid,uuid,jsonb,text,text)
TO authenticated;

COMMENT ON FUNCTION public.reconcile_inventory_levels_v2(uuid,uuid,uuid,jsonb,text,text) IS
  'Atomically reconciles physical target stock levels from server-current quantities with signed adjustment evidence and exactly-once operation replay.';

COMMIT;
