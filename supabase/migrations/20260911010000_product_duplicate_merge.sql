-- Server-authoritative duplicate-product consolidation.
-- Historical transactional rows remain attached to their original product IDs;
-- only live catalogue identity, barcodes, and current stock are consolidated.

BEGIN;

CREATE TABLE public.product_merge_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_product_id uuid NOT NULL,
  canonical_product_id uuid NOT NULL,
  merged_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  operation_id text NOT NULL CHECK (length(btrim(operation_id)) >= 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_merge_aliases_source_fkey
    FOREIGN KEY (tenant_id, source_product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_merge_aliases_canonical_fkey
    FOREIGN KEY (tenant_id, canonical_product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_merge_aliases_different_products
    CHECK (source_product_id <> canonical_product_id),
  UNIQUE (tenant_id, source_product_id),
  UNIQUE (tenant_id, operation_id)
);

CREATE INDEX product_merge_aliases_canonical_idx
  ON public.product_merge_aliases(tenant_id, canonical_product_id);

CREATE TABLE public.product_merge_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_product_id uuid NOT NULL,
  canonical_product_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(btrim(operation_id)) >= 8),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{32}$'),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  result_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT product_merge_operations_source_fkey
    FOREIGN KEY (tenant_id, source_product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_merge_operations_canonical_fkey
    FOREIGN KEY (tenant_id, canonical_product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_merge_operations_different_products
    CHECK (source_product_id <> canonical_product_id),
  UNIQUE (tenant_id, operation_id)
);

CREATE INDEX product_merge_operations_source_idx
  ON public.product_merge_operations(tenant_id, source_product_id, created_at DESC);

ALTER TABLE public.product_merge_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_merge_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_merge_aliases_tenant_select
ON public.product_merge_aliases FOR SELECT TO authenticated
USING (public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY product_merge_operations_manager_select
ON public.product_merge_operations FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.tenant_id = product_merge_operations.tenant_id
      AND ur.branch_id IS NULL
      AND ur.role = ANY (ARRAY['owner','admin','manager']::public.app_role[])
  )
);

REVOKE ALL ON public.product_merge_aliases, public.product_merge_operations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.product_merge_aliases, public.product_merge_operations
  TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_tenant_catalogue_v1(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.tenant_id = _tenant_id
        AND ur.branch_id IS NULL
        AND ur.role = ANY (ARRAY['owner','admin','manager']::public.app_role[])
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_tenant_catalogue_v1(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.resolve_canonical_product_id_v1(
  _tenant_id uuid,
  _product_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _current uuid := _product_id;
  _next uuid;
  _depth integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Product canonical resolution is forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.tenant_id = _tenant_id AND p.id = _product_id
  ) THEN
    RETURN NULL;
  END IF;

  LOOP
    SELECT a.canonical_product_id INTO _next
    FROM public.product_merge_aliases a
    WHERE a.tenant_id = _tenant_id AND a.source_product_id = _current;

    IF _next IS NULL THEN
      RETURN _current;
    END IF;

    _current := _next;
    _depth := _depth + 1;
    IF _depth > 32 THEN
      RAISE EXCEPTION 'Product canonical alias chain is invalid';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_canonical_product_id_v1(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_canonical_product_id_v1(uuid,uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.preview_product_merge_v1(
  _tenant_id uuid,
  _source_product_id uuid,
  _canonical_product_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _blockers jsonb := '[]'::jsonb;
  _source_stock numeric(20,3) := 0;
  _canonical_stock numeric(20,3) := 0;
  _source_barcodes integer := 0;
BEGIN
  IF NOT public.can_manage_tenant_catalogue_v1(_tenant_id) THEN
    RAISE EXCEPTION 'Product merge preview is forbidden';
  END IF;
  IF _source_product_id IS NULL OR _canonical_product_id IS NULL
     OR _source_product_id = _canonical_product_id THEN
    RAISE EXCEPTION 'Source and canonical products must be different';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.tenant_id = _tenant_id AND p.id = _source_product_id
  ) THEN
    RAISE EXCEPTION 'Source product does not belong to this tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.tenant_id = _tenant_id AND p.id = _canonical_product_id
  ) THEN
    RAISE EXCEPTION 'Canonical product does not belong to this tenant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_merge_aliases a
    WHERE a.tenant_id = _tenant_id AND a.source_product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('already_merged');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.held_cart_items hci
    JOIN public.held_carts hc ON hc.id = hci.held_cart_id
      AND hc.tenant_id = hci.tenant_id
    WHERE hci.tenant_id = _tenant_id
      AND hci.product_id = _source_product_id
      AND hc.status = 'held'
  ) THEN
    _blockers := _blockers || jsonb_build_array('held_cart');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.production_orders po
    WHERE po.tenant_id = _tenant_id
      AND po.product_id = _source_product_id
      AND po.status IN ('draft','in_progress')
  ) THEN
    _blockers := _blockers || jsonb_build_array('production');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.price_override_requests por
    WHERE por.tenant_id = _tenant_id
      AND por.product_id = _source_product_id
      AND por.status IN ('pending','approved')
  ) THEN
    _blockers := _blockers || jsonb_build_array('price_override');
  END IF;

  SELECT COALESCE(sum(s.quantity),0)::numeric(20,3)
  INTO _source_stock
  FROM public.inventory_stocks s
  WHERE s.tenant_id = _tenant_id AND s.product_id = _source_product_id;

  SELECT COALESCE(sum(s.quantity),0)::numeric(20,3)
  INTO _canonical_stock
  FROM public.inventory_stocks s
  WHERE s.tenant_id = _tenant_id AND s.product_id = _canonical_product_id;

  SELECT count(*)::integer INTO _source_barcodes
  FROM public.product_barcodes b
  WHERE b.tenant_id = _tenant_id AND b.product_id = _source_product_id;

  RETURN jsonb_build_object(
    'tenant_id', _tenant_id,
    'source_product_id', _source_product_id,
    'canonical_product_id', _canonical_product_id,
    'can_merge', jsonb_array_length(_blockers) = 0,
    'blockers', _blockers,
    'source_stock_quantity', to_char(_source_stock, 'FM999999999999990.000'),
    'canonical_stock_quantity', to_char(_canonical_stock, 'FM999999999999990.000'),
    'combined_stock_quantity', to_char((_source_stock + _canonical_stock)::numeric(20,3), 'FM999999999999990.000'),
    'source_barcode_count', _source_barcodes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_product_merge_v1(uuid,uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_product_merge_v1(uuid,uuid,uuid)
  TO authenticated;

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

  -- Current stock is mutable state. Move its exact signed quantity to the canonical
  -- product, while writing two compensating adjustment movements per center.
  FOR _stock IN
    SELECT s.branch_id, s.inventory_center_id, s.quantity
    FROM public.inventory_stocks s
    WHERE s.tenant_id = _tenant_id
      AND s.product_id = _source_product_id
      AND s.quantity <> 0
    ORDER BY s.inventory_center_id
    FOR UPDATE
  LOOP
    PERFORM public.apply_inventory_movement(
      _tenant_id, _stock.branch_id, _source_product_id,
      'adjustment'::public.movement_type, -_stock.quantity,
      'Duplicate product merge to ' || _canonical_product_id::text,
      'product_merge', _merge_operation_id, _user_id, _stock.inventory_center_id
    );
    PERFORM public.apply_inventory_movement(
      _tenant_id, _stock.branch_id, _canonical_product_id,
      'adjustment'::public.movement_type, _stock.quantity,
      'Duplicate product merge from ' || _source_product_id::text,
      'product_merge', _merge_operation_id, _user_id, _stock.inventory_center_id
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
