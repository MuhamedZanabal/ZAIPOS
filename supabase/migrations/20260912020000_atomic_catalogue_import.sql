-- Atomic, exact-fils catalogue import.
-- A complete import file is one authoritative database operation: prevalidated,
-- payload-bound, idempotent and committed (or rolled back) as one statement.

BEGIN;

CREATE TABLE public.product_catalogue_import_operations (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  actor_user_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT product_catalogue_import_operation_id_nonblank CHECK (length(btrim(operation_id)) >= 8),
  CONSTRAINT product_catalogue_import_request_hash_nonblank CHECK (length(request_hash) >= 16)
);

CREATE INDEX product_catalogue_import_operations_actor_idx
  ON public.product_catalogue_import_operations(tenant_id, actor_user_id, completed_at DESC);

ALTER TABLE public.product_catalogue_import_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_catalogue_import_operations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.import_product_catalogue_v1(
  _tenant_id uuid,
  _operation_id text,
  _rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request_hash text;
  _existing public.product_catalogue_import_operations;
  _row jsonb;
  _product_id uuid;
  _name text;
  _sku text;
  _status public.entity_status;
  _product_type public.product_type;
  _unit_code text;
  _selling_fils bigint;
  _cost_fils bigint;
  _tax_rate numeric;
  _min_stock numeric;
  _barcodes jsonb;
  _inspection jsonb;
  _conflict jsonb;
  _created integer := 0;
  _updated integer := 0;
  _result jsonb;
  _exists_here boolean;
  _current_price_fils bigint;
  _current_cost_fils bigint;
  _financial_operation_id text;
  _barcode_operation_id text;
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'Catalogue import requires an authenticated user';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _actor_id
      AND ur.tenant_id = _tenant_id
      AND ur.branch_id IS NULL
      AND ur.role = ANY (ARRAY['owner','admin','manager']::public.app_role[])
  ) THEN
    RAISE EXCEPTION 'Catalogue import is forbidden: a tenant-wide manager role is required';
  END IF;

  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'A stable catalogue import operation ID is required';
  END IF;
  IF _rows IS NULL OR jsonb_typeof(_rows) <> 'array' OR jsonb_array_length(_rows) = 0 THEN
    RAISE EXCEPTION 'Catalogue import rows must be a non-empty JSON array';
  END IF;
  IF jsonb_array_length(_rows) > 10000 THEN
    RAISE EXCEPTION 'Catalogue import is limited to 10000 rows per operation';
  END IF;

  _request_hash := md5(jsonb_build_object('tenant_id', _tenant_id, 'rows', _rows)::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(_tenant_id::text || ':catalogue-import:' || _operation_id, 0)
  );

  SELECT * INTO _existing
  FROM public.product_catalogue_import_operations
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF _existing.request_hash <> _request_hash THEN
      RAISE EXCEPTION 'Catalogue import operation ID was already used with different input payload';
    END IF;
    RETURN _existing.result;
  END IF;

  -- Validate row shape and all product-level fields before any mutation.
  FOR _row IN SELECT value FROM jsonb_array_elements(_rows)
  LOOP
    IF jsonb_typeof(_row) <> 'object' THEN
      RAISE EXCEPTION 'Every catalogue import row must be a JSON object';
    END IF;
    IF NULLIF(btrim(COALESCE(_row->>'id','')), '') IS NULL THEN
      RAISE EXCEPTION 'Every catalogue import row requires a stable product id';
    END IF;
    BEGIN
      _product_id := (_row->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Catalogue product id is not a valid UUID: %', _row->>'id';
    END;

    _name := btrim(COALESCE(_row->>'name',''));
    IF length(_name) = 0 THEN RAISE EXCEPTION 'Every catalogue import row requires a product name'; END IF;

    _sku := NULLIF(btrim(COALESCE(_row->>'sku','')), '');
    _unit_code := COALESCE(NULLIF(btrim(COALESCE(_row->>'unit_code','')), ''), 'unit');
    IF length(_unit_code) > 64 THEN RAISE EXCEPTION 'Product unit_code is too long for product %', _product_id; END IF;

    BEGIN
      _status := COALESCE(NULLIF(lower(btrim(_row->>'status')), ''), 'active')::public.entity_status;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid product status for product %', _product_id;
    END;
    BEGIN
      _product_type := COALESCE(NULLIF(lower(btrim(_row->>'product_type')), ''), 'simple')::public.product_type;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid product_type for product %', _product_id;
    END;

    IF jsonb_typeof(_row->'selling_amount_fils') <> 'number'
      OR ((_row->>'selling_amount_fils')::numeric < 0)
      OR ((_row->>'selling_amount_fils')::numeric <> trunc((_row->>'selling_amount_fils')::numeric))
      OR ((_row->>'selling_amount_fils')::numeric > 9223372036854775807::numeric)
    THEN
      RAISE EXCEPTION 'selling_amount_fils must be a non-negative integer for product %', _product_id;
    END IF;
    IF jsonb_typeof(_row->'cost_amount_fils') <> 'number'
      OR ((_row->>'cost_amount_fils')::numeric < 0)
      OR ((_row->>'cost_amount_fils')::numeric <> trunc((_row->>'cost_amount_fils')::numeric))
      OR ((_row->>'cost_amount_fils')::numeric > 9223372036854775807::numeric)
    THEN
      RAISE EXCEPTION 'cost_amount_fils must be a non-negative integer for product %', _product_id;
    END IF;

    _selling_fils := (_row->>'selling_amount_fils')::bigint;
    _cost_fils := (_row->>'cost_amount_fils')::bigint;

    IF _row ? 'tax_rate' AND jsonb_typeof(_row->'tax_rate') <> 'number' THEN
      RAISE EXCEPTION 'tax_rate must be numeric for product %', _product_id;
    END IF;
    _tax_rate := COALESCE((_row->>'tax_rate')::numeric, 10);
    IF _tax_rate < 0 OR _tax_rate > 100 THEN RAISE EXCEPTION 'tax_rate must be between 0 and 100 for product %', _product_id; END IF;

    IF _row ? 'min_stock' AND jsonb_typeof(_row->'min_stock') <> 'number' THEN
      RAISE EXCEPTION 'min_stock must be numeric for product %', _product_id;
    END IF;
    _min_stock := COALESCE((_row->>'min_stock')::numeric, 0);
    IF _min_stock < 0 OR _min_stock > 1000000000 THEN RAISE EXCEPTION 'min_stock is out of range for product %', _product_id; END IF;

    _barcodes := COALESCE(_row->'barcodes', '[]'::jsonb);
    IF jsonb_typeof(_barcodes) <> 'array' OR jsonb_array_length(_barcodes) > 64 THEN
      RAISE EXCEPTION 'barcodes must be an array with at most 64 entries for product %', _product_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.products p WHERE p.id = _product_id AND p.tenant_id <> _tenant_id) THEN
      RAISE EXCEPTION 'Product % belongs to another tenant', _product_id;
    END IF;
    IF _sku IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.tenant_id = _tenant_id AND p.sku = _sku AND p.id <> _product_id
    ) THEN
      RAISE EXCEPTION 'SKU % conflicts with another catalogue product', _sku;
    END IF;

    _inspection := public.inspect_product_barcode_candidates_v1(_tenant_id, _product_id, _barcodes);
    SELECT value INTO _conflict
    FROM jsonb_array_elements(_inspection)
    WHERE value->>'state' <> 'valid'
    LIMIT 1;
    IF _conflict IS NOT NULL THEN
      RAISE EXCEPTION 'Barcode % conflicts with catalogue state %',
        COALESCE(_conflict->>'normalized_barcode','(empty)'), COALESCE(_conflict->>'state','invalid');
    END IF;
    _conflict := NULL;
  END LOOP;

  -- File-wide uniqueness is checked separately because new rows do not yet exist
  -- in product_barcodes and therefore cannot be detected by per-product inspection.
  IF EXISTS (
    WITH incoming AS (
      SELECT upper(btrim(COALESCE(barcode.value->>'barcode',''))) AS normalized
      FROM jsonb_array_elements(_rows) row_item(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(row_item.value->'barcodes','[]'::jsonb)) barcode(value)
    )
    SELECT 1 FROM incoming
    GROUP BY normalized
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate barcode exists inside the catalogue import payload';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT NULLIF(btrim(COALESCE(value->>'sku','')), '') AS sku
      FROM jsonb_array_elements(_rows)
    ) incoming
    WHERE sku IS NOT NULL
    GROUP BY sku
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate SKU exists inside the catalogue import payload';
  END IF;

  -- Mutation phase. PostgreSQL statement atomicity means any error below rolls
  -- back every prior row, child command ledger entry, history entry and barcode.
  FOR _row IN SELECT value FROM jsonb_array_elements(_rows)
  LOOP
    _product_id := (_row->>'id')::uuid;
    _name := btrim(_row->>'name');
    _sku := NULLIF(btrim(COALESCE(_row->>'sku','')), '');
    _unit_code := COALESCE(NULLIF(btrim(COALESCE(_row->>'unit_code','')), ''), 'unit');
    _status := COALESCE(NULLIF(lower(btrim(_row->>'status')), ''), 'active')::public.entity_status;
    _product_type := COALESCE(NULLIF(lower(btrim(_row->>'product_type')), ''), 'simple')::public.product_type;
    _selling_fils := (_row->>'selling_amount_fils')::bigint;
    _cost_fils := (_row->>'cost_amount_fils')::bigint;
    _tax_rate := COALESCE((_row->>'tax_rate')::numeric, 10);
    _min_stock := COALESCE((_row->>'min_stock')::numeric, 0);
    _barcodes := COALESCE(_row->'barcodes', '[]'::jsonb);

    SELECT true, p.price_fils, p.cost_fils
      INTO _exists_here, _current_price_fils, _current_cost_fils
    FROM public.products p
    WHERE p.tenant_id = _tenant_id AND p.id = _product_id
    FOR UPDATE;

    IF COALESCE(_exists_here, false) THEN
      IF _current_price_fils IS DISTINCT FROM _selling_fils OR _current_cost_fils IS DISTINCT FROM _cost_fils THEN
        _financial_operation_id := _operation_id || ':financial:' || _product_id::text;
        PERFORM public.set_product_base_financials_v1(
          _tenant_id, _product_id, _selling_fils, _cost_fils,
          'Catalogue CSV import', _financial_operation_id
        );
      END IF;

      UPDATE public.products
      SET name = _name,
          sku = _sku,
          tax_rate = _tax_rate,
          min_stock = _min_stock,
          status = _status,
          unit_code = _unit_code,
          product_type = _product_type,
          updated_at = now()
      WHERE tenant_id = _tenant_id AND id = _product_id;
      _updated := _updated + 1;
    ELSE
      INSERT INTO public.products(
        id, tenant_id, name, sku, price, cost, tax_rate, min_stock,
        status, unit_code, product_type
      ) VALUES (
        _product_id, _tenant_id, _name, _sku,
        public.fils_to_bhd_numeric(_selling_fils),
        public.fils_to_bhd_numeric(_cost_fils),
        _tax_rate, _min_stock, _status, _unit_code, _product_type
      );
      _created := _created + 1;
    END IF;

    _barcode_operation_id := _operation_id || ':barcodes:' || _product_id::text;
    PERFORM public.replace_product_barcodes_v1(
      _tenant_id, _product_id, _barcodes, _barcode_operation_id
    );

    _exists_here := false;
    _current_price_fils := NULL;
    _current_cost_fils := NULL;
  END LOOP;

  _result := jsonb_build_object(
    'operation_id', _operation_id,
    'processed', jsonb_array_length(_rows),
    'created', _created,
    'updated', _updated,
    'request_hash', _request_hash
  );

  INSERT INTO public.product_catalogue_import_operations(
    tenant_id, operation_id, request_hash, actor_user_id, result
  ) VALUES (_tenant_id, _operation_id, _request_hash, _actor_id, _result);

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,metadata)
  VALUES (
    _tenant_id,_actor_id,'catalogue.products_imported','catalogue',
    jsonb_build_object(
      'operation_id',_operation_id,
      'request_hash',_request_hash,
      'processed',jsonb_array_length(_rows),
      'created',_created,
      'updated',_updated
    )
  );

  RETURN _result;
END
$$;

REVOKE ALL ON FUNCTION public.import_product_catalogue_v1(uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_product_catalogue_v1(uuid,text,jsonb) TO authenticated;

COMMIT;
