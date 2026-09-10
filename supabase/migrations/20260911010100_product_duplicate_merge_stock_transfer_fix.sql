-- Fix duplicate-product stock consolidation without weakening the shared inventory primitive.
-- apply_inventory_movement requires positive command quantities, while a product merge
-- needs a signed adjustment on the retiring source. Mirror the established physical
-- reconciliation pattern: lock authoritative stock, update exact levels, and append
-- compensating signed adjustment evidence in the same transaction.

BEGIN;

CREATE OR REPLACE FUNCTION public.merge_duplicate_product_v1(
  _tenant_id uuid,
  _source_product_id uuid,
  _canonical_product_id uuid,
  _reason text,
  _operation_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _clean_reason text := NULLIF(btrim(COALESCE(_reason,'')), '');
  _clean_operation_id text := NULLIF(btrim(COALESCE(_operation_id,'')), '');
  _request_hash text;
  _existing public.product_merge_operations;
  _merge_operation_id uuid;
  _preview jsonb;
  _stock record;
  _target_has_primary boolean;
  _max_sort integer;
  _result text;
  _previous_barcode_setting text;
  _source_delta numeric(20,3);
  _target_delta numeric(20,3);
BEGIN
  IF _user_id IS NULL OR NOT public.can_manage_tenant_catalogue_v1(_tenant_id) THEN
    RAISE EXCEPTION 'Product merge is forbidden';
  END IF;
  IF _source_product_id IS NULL OR _canonical_product_id IS NULL
     OR _source_product_id = _canonical_product_id THEN
    RAISE EXCEPTION 'Source and canonical products must be different';
  END IF;
  IF _clean_reason IS NULL OR length(_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Product merge reason is required';
  END IF;
  IF _clean_operation_id IS NULL OR length(_clean_operation_id) < 8 THEN
    RAISE EXCEPTION 'A stable product merge operation ID is required';
  END IF;

  _request_hash := md5(
    _tenant_id::text || '|' || _source_product_id::text || '|' ||
    _canonical_product_id::text || '|' || _clean_reason
  );

  -- Tenant row lock serializes catalogue merges, including different operation IDs.
  PERFORM 1 FROM public.tenants t WHERE t.id = _tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product merge tenant not found';
  END IF;

  SELECT * INTO _existing
  FROM public.product_merge_operations o
  WHERE o.tenant_id = _tenant_id AND o.operation_id = _clean_operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF _existing.request_hash IS DISTINCT FROM _request_hash
       OR _existing.source_product_id IS DISTINCT FROM _source_product_id
       OR _existing.canonical_product_id IS DISTINCT FROM _canonical_product_id
    THEN
      RAISE EXCEPTION 'Product merge operation ID was already used for different input';
    END IF;
    IF _existing.status = 'completed' AND _existing.result_text IS NOT NULL THEN
      RETURN _existing.result_text;
    END IF;
    RAISE EXCEPTION 'Product merge operation is already processing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.product_merge_aliases a
    WHERE a.tenant_id = _tenant_id AND a.source_product_id = _source_product_id
  ) THEN
    RAISE EXCEPTION 'Source product is already merged into a canonical product';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.tenant_id = _tenant_id
      AND p.id = _source_product_id
      AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Source product is invalid, inactive, or already merged';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.tenant_id = _tenant_id
      AND p.id = _canonical_product_id
      AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Canonical product is invalid or inactive for this tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_merge_aliases a
    WHERE a.tenant_id = _tenant_id AND a.source_product_id = _canonical_product_id
  ) THEN
    RAISE EXCEPTION 'Canonical product must itself be canonical and active';
  END IF;

  -- Lock both product rows in deterministic UUID order before rechecking blockers.
  PERFORM 1
  FROM public.products p
  WHERE p.tenant_id = _tenant_id
    AND p.id IN (_source_product_id, _canonical_product_id)
  ORDER BY p.id
  FOR UPDATE;

  _preview := public.preview_product_merge_v1(
    _tenant_id, _source_product_id, _canonical_product_id
  );
  IF COALESCE((_preview->>'can_merge')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Product merge blocked: %', COALESCE(_preview->'blockers', '[]'::jsonb)::text;
  END IF;

  INSERT INTO public.product_merge_operations(
    tenant_id, source_product_id, canonical_product_id,
    operation_id, request_hash, actor_id, reason
  ) VALUES (
    _tenant_id, _source_product_id, _canonical_product_id,
    _clean_operation_id, _request_hash, _user_id, _clean_reason
  ) RETURNING id INTO _merge_operation_id;

  -- Current stock is mutable authoritative state. For each source stock position,
  -- create/lock the target row, zero the source, add the exact source quantity to
  -- the canonical row, and append compensating signed adjustment evidence.
  FOR _stock IN
    SELECT s.branch_id, s.inventory_center_id, s.quantity
    FROM public.inventory_stocks s
    WHERE s.tenant_id = _tenant_id
      AND s.product_id = _source_product_id
      AND s.quantity <> 0
    ORDER BY s.inventory_center_id
    FOR UPDATE
  LOOP
    INSERT INTO public.inventory_stocks(
      tenant_id, branch_id, inventory_center_id, product_id, quantity
    ) VALUES (
      _tenant_id, _stock.branch_id, _stock.inventory_center_id,
      _canonical_product_id, 0
    )
    ON CONFLICT (inventory_center_id, product_id) DO NOTHING;

    PERFORM 1
    FROM public.inventory_stocks target_stock
    WHERE target_stock.tenant_id = _tenant_id
      AND target_stock.branch_id = _stock.branch_id
      AND target_stock.inventory_center_id = _stock.inventory_center_id
      AND target_stock.product_id = _canonical_product_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Could not lock canonical inventory stock row for product merge';
    END IF;

    _source_delta := (-_stock.quantity)::numeric(20,3);
    _target_delta := _stock.quantity::numeric(20,3);

    UPDATE public.inventory_stocks
    SET quantity = 0,
        updated_at = now()
    WHERE tenant_id = _tenant_id
      AND branch_id = _stock.branch_id
      AND inventory_center_id = _stock.inventory_center_id
      AND product_id = _source_product_id;

    UPDATE public.inventory_stocks
    SET quantity = quantity + _target_delta,
        updated_at = now()
    WHERE tenant_id = _tenant_id
      AND branch_id = _stock.branch_id
      AND inventory_center_id = _stock.inventory_center_id
      AND product_id = _canonical_product_id;

    INSERT INTO public.inventory_movements(
      tenant_id, branch_id, inventory_center_id, product_id,
      movement_type, quantity, reason, reference_type, reference_id, user_id
    ) VALUES
      (
        _tenant_id, _stock.branch_id, _stock.inventory_center_id, _source_product_id,
        'adjustment'::public.movement_type, _source_delta,
        'Duplicate product merge to ' || _canonical_product_id::text,
        'product_merge', _merge_operation_id, _user_id
      ),
      (
        _tenant_id, _stock.branch_id, _stock.inventory_center_id, _canonical_product_id,
        'adjustment'::public.movement_type, _target_delta,
        'Duplicate product merge from ' || _source_product_id::text,
        'product_merge', _merge_operation_id, _user_id
      );
  END LOOP;

  -- Preserve the target's existing primary barcode. Clear the legacy source mirror
  -- first so the source does not retain a barcode string after ledger rows move.
  SELECT EXISTS (
    SELECT 1 FROM public.product_barcodes b
    WHERE b.tenant_id = _tenant_id
      AND b.product_id = _canonical_product_id
      AND b.is_primary
  ) INTO _target_has_primary;

  _previous_barcode_setting := COALESCE(current_setting('zaipos.product_barcode_command', true), '');
  PERFORM set_config('zaipos.product_barcode_command', 'on', true);
  UPDATE public.products
  SET barcode = NULL
  WHERE tenant_id = _tenant_id AND id = _source_product_id AND barcode IS NOT NULL;
  PERFORM set_config('zaipos.product_barcode_command', _previous_barcode_setting, true);

  IF _target_has_primary THEN
    UPDATE public.product_barcodes
    SET is_primary = false
    WHERE tenant_id = _tenant_id
      AND product_id = _source_product_id
      AND is_primary;
  END IF;

  SELECT COALESCE(max(b.sort_order), -1) INTO _max_sort
  FROM public.product_barcodes b
  WHERE b.tenant_id = _tenant_id AND b.product_id = _canonical_product_id;

  WITH moved AS (
    SELECT b.id,
      row_number() OVER (ORDER BY b.sort_order, b.created_at, b.id)::integer AS rn
    FROM public.product_barcodes b
    WHERE b.tenant_id = _tenant_id AND b.product_id = _source_product_id
  )
  UPDATE public.product_barcodes b
  SET product_id = _canonical_product_id,
      sort_order = (_max_sort + moved.rn)::smallint,
      updated_at = now()
  FROM moved
  WHERE b.id = moved.id;

  IF NOT EXISTS (
    SELECT 1 FROM public.product_barcodes b
    WHERE b.tenant_id = _tenant_id
      AND b.product_id = _canonical_product_id
      AND b.is_primary
  ) THEN
    UPDATE public.product_barcodes b
    SET is_primary = true
    WHERE b.id = (
      SELECT b2.id
      FROM public.product_barcodes b2
      WHERE b2.tenant_id = _tenant_id
        AND b2.product_id = _canonical_product_id
      ORDER BY b2.sort_order, b2.created_at, b2.id
      LIMIT 1
    );
  END IF;

  UPDATE public.products
  SET status = 'inactive'
  WHERE tenant_id = _tenant_id AND id = _source_product_id;

  INSERT INTO public.product_merge_aliases(
    tenant_id, source_product_id, canonical_product_id,
    merged_by, reason, operation_id
  ) VALUES (
    _tenant_id, _source_product_id, _canonical_product_id,
    _user_id, _clean_reason, _clean_operation_id
  );

  _result := format(
    '{"canonical_product_id":"%s","source_product_id":"%s"}',
    _canonical_product_id::text, _source_product_id::text
  );

  UPDATE public.product_merge_operations
  SET status = 'completed', result_text = _result, completed_at = now()
  WHERE id = _merge_operation_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (
    _tenant_id, _user_id, 'catalogue.product_merged',
    'products', _source_product_id,
    jsonb_build_object(
      'canonical_product_id', _canonical_product_id,
      'operation_id', _clean_operation_id,
      'reason', _clean_reason
    )
  );

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_duplicate_product_v1(uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_product_v1(uuid,uuid,uuid,text,text)
  TO authenticated;

COMMIT;
