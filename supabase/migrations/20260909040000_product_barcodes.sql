-- Tenant-safe product barcode ledger with explicit collision evidence and a
-- backwards-compatible primary barcode mirror on public.products.

BEGIN;

CREATE TABLE public.product_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  barcode text NOT NULL,
  normalized_barcode text GENERATED ALWAYS AS (upper(btrim(barcode))) STORED,
  barcode_type text NOT NULL DEFAULT 'internal'
    CHECK (barcode_type IN ('ean_8','ean_13','upc_a','code_128','qr','internal','supplier','legacy')),
  is_primary boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_barcodes_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_barcodes_format_check
    CHECK (
      barcode = upper(btrim(barcode)) AND barcode ~ '^[!-~]{1,128}$'
      AND (barcode_type <> 'ean_8' OR barcode ~ '^[0-9]{8}$')
      AND (barcode_type <> 'ean_13' OR barcode ~ '^[0-9]{13}$')
      AND (barcode_type <> 'upc_a' OR barcode ~ '^[0-9]{12}$')
    ),
  UNIQUE (tenant_id, normalized_barcode),
  UNIQUE (tenant_id, product_id, sort_order)
);

CREATE UNIQUE INDEX product_barcodes_one_primary
  ON public.product_barcodes(tenant_id, product_id)
  WHERE is_primary;
CREATE INDEX product_barcodes_product_lookup
  ON public.product_barcodes(tenant_id, product_id, is_primary DESC, sort_order);

CREATE TABLE public.product_barcode_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  candidate_product_id uuid NOT NULL,
  conflicting_product_id uuid,
  barcode text NOT NULL,
  normalized_barcode text NOT NULL,
  source text NOT NULL CHECK (source IN ('legacy_migration','manual','import','supplier')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','dismissed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT product_barcode_conflicts_candidate_fkey
    FOREIGN KEY (tenant_id, candidate_product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_barcode_conflicts_existing_fkey
    FOREIGN KEY (tenant_id, conflicting_product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE CASCADE,
  CHECK ((state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR (state IN ('resolved','dismissed') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);

CREATE INDEX product_barcode_conflicts_review
  ON public.product_barcode_conflicts(tenant_id, state, created_at DESC);

CREATE TABLE public.product_barcode_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(btrim(operation_id)) >= 8),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{32}$'),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT product_barcode_operations_product_fkey
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, operation_id)
);

ALTER TABLE public.product_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_barcode_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_barcode_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_barcodes_tenant_select
ON public.product_barcodes FOR SELECT TO authenticated
USING (public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY product_barcode_conflicts_manager_select
ON public.product_barcode_conflicts FOR SELECT TO authenticated
USING (public.has_any_role(auth.uid(), tenant_id, ARRAY['owner','admin','manager']::public.app_role[]));

CREATE POLICY product_barcode_operations_manager_select
ON public.product_barcode_operations FOR SELECT TO authenticated
USING (public.has_any_role(auth.uid(), tenant_id, ARRAY['owner','admin','manager']::public.app_role[]));

REVOKE ALL ON public.product_barcodes, public.product_barcode_conflicts, public.product_barcode_operations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.product_barcodes, public.product_barcode_conflicts, public.product_barcode_operations
  TO authenticated;

CREATE OR REPLACE FUNCTION public.normalize_product_barcode_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.barcode := upper(btrim(NEW.barcode));
  NEW.barcode_type := lower(btrim(NEW.barcode_type));
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.normalize_product_barcode_row() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER product_barcodes_normalize
BEFORE INSERT OR UPDATE OF barcode, barcode_type ON public.product_barcodes
FOR EACH ROW EXECUTE FUNCTION public.normalize_product_barcode_row();

CREATE TRIGGER product_barcodes_updated_at
BEFORE UPDATE ON public.product_barcodes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Preserve valid unique legacy barcodes. Malformed and duplicate legacy values
-- are retained in the review ledger before being cleared from the old mirror.
WITH legacy AS (
  SELECT p.id, p.tenant_id, p.barcode,
    upper(btrim(p.barcode)) AS normalized_barcode,
    row_number() OVER (
      PARTITION BY p.tenant_id, upper(btrim(p.barcode))
      ORDER BY (p.status = 'active') DESC, p.created_at, p.id
    ) AS duplicate_rank,
    first_value(p.id) OVER (
      PARTITION BY p.tenant_id, upper(btrim(p.barcode))
      ORDER BY (p.status = 'active') DESC, p.created_at, p.id
    ) AS winning_product_id
  FROM public.products p
  WHERE p.barcode IS NOT NULL AND btrim(p.barcode) <> ''
), recorded AS (
  INSERT INTO public.product_barcode_conflicts(
    tenant_id, candidate_product_id, conflicting_product_id,
    barcode, normalized_barcode, source, details
  )
  SELECT tenant_id, id,
    CASE WHEN normalized_barcode ~ '^[!-~]{1,128}$' THEN winning_product_id ELSE NULL END,
    barcode, normalized_barcode, 'legacy_migration',
    jsonb_build_object(
      'reason', CASE WHEN normalized_barcode !~ '^[!-~]{1,128}$' THEN 'malformed' ELSE 'duplicate' END,
      'preserved_legacy_value', barcode
    )
  FROM legacy
  WHERE normalized_barcode !~ '^[!-~]{1,128}$' OR duplicate_rank > 1
  RETURNING candidate_product_id
)
UPDATE public.products p
SET barcode = NULL
FROM recorded r
WHERE p.id = r.candidate_product_id;

WITH legacy AS (
  SELECT p.id, p.tenant_id, upper(btrim(p.barcode)) AS barcode,
    row_number() OVER (
      PARTITION BY p.tenant_id, upper(btrim(p.barcode))
      ORDER BY (p.status = 'active') DESC, p.created_at, p.id
    ) AS duplicate_rank
  FROM public.products p
  WHERE p.barcode IS NOT NULL AND btrim(p.barcode) <> ''
)
INSERT INTO public.product_barcodes(tenant_id, product_id, barcode, barcode_type, is_primary, sort_order)
SELECT tenant_id, id, barcode, 'legacy', true, 0
FROM legacy
WHERE duplicate_rank = 1 AND barcode ~ '^[!-~]{1,128}$';

UPDATE public.products p
SET barcode = b.barcode
FROM public.product_barcodes b
WHERE b.product_id = p.id AND b.tenant_id = p.tenant_id AND b.is_primary
  AND p.barcode IS DISTINCT FROM b.barcode;

CREATE OR REPLACE FUNCTION public.guard_legacy_product_barcode_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.barcode IS NOT NULL THEN
    NEW.barcode := upper(btrim(NEW.barcode));
    IF NEW.barcode = '' THEN NEW.barcode := NULL; END IF;
  END IF;

  IF auth.uid() IS NOT NULL
    AND ((TG_OP = 'INSERT' AND NEW.barcode IS NOT NULL)
      OR (TG_OP = 'UPDATE' AND NEW.barcode IS DISTINCT FROM OLD.barcode))
    AND COALESCE(current_setting('zaipos.product_barcode_command', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'Product barcode changes must use replace_product_barcodes_v1';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.guard_legacy_product_barcode_write() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER products_barcode_write_guard
BEFORE INSERT OR UPDATE OF barcode ON public.products
FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_product_barcode_write();

CREATE OR REPLACE FUNCTION public.sync_legacy_product_barcode_to_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _existing_product_id uuid;
  _existing_id uuid;
  _next_order smallint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.barcode IS NOT DISTINCT FROM OLD.barcode THEN RETURN NEW; END IF;

  IF NEW.barcode IS NULL THEN
    UPDATE public.product_barcodes
    SET is_primary = false
    WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id AND is_primary;
    RETURN NEW;
  END IF;

  SELECT product_id INTO _existing_product_id
  FROM public.product_barcodes
  WHERE tenant_id = NEW.tenant_id AND normalized_barcode = upper(btrim(NEW.barcode));
  IF _existing_product_id IS NOT NULL AND _existing_product_id <> NEW.id THEN
    RAISE EXCEPTION 'Barcode collision: % already belongs to product %', NEW.barcode, _existing_product_id;
  END IF;

  UPDATE public.product_barcodes
  SET is_primary = false
  WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id AND is_primary;

  SELECT id INTO _existing_id
  FROM public.product_barcodes
  WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id
    AND normalized_barcode = upper(btrim(NEW.barcode));

  IF _existing_id IS NOT NULL THEN
    UPDATE public.product_barcodes SET is_primary = true WHERE id = _existing_id;
  ELSE
    SELECT COALESCE(max(sort_order) + 1, 0)::smallint INTO _next_order
    FROM public.product_barcodes
    WHERE tenant_id = NEW.tenant_id AND product_id = NEW.id;
    INSERT INTO public.product_barcodes(tenant_id, product_id, barcode, barcode_type, is_primary, sort_order)
    VALUES (NEW.tenant_id, NEW.id, NEW.barcode, 'legacy', true, _next_order);
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sync_legacy_product_barcode_to_ledger() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER products_barcode_ledger_sync
AFTER INSERT OR UPDATE OF barcode ON public.products
FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_product_barcode_to_ledger();

CREATE OR REPLACE FUNCTION public.sync_product_barcode_primary_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _tenant_id uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
  _product_id uuid := COALESCE(NEW.product_id, OLD.product_id);
  _primary text;
  _previous_setting text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT barcode INTO _primary
  FROM public.product_barcodes
  WHERE tenant_id = _tenant_id AND product_id = _product_id AND is_primary
  ORDER BY sort_order, created_at, id
  LIMIT 1;

  _previous_setting := COALESCE(current_setting('zaipos.product_barcode_command', true), '');
  PERFORM set_config('zaipos.product_barcode_command', 'on', true);
  UPDATE public.products
  SET barcode = _primary
  WHERE tenant_id = _tenant_id AND id = _product_id AND barcode IS DISTINCT FROM _primary;
  PERFORM set_config('zaipos.product_barcode_command', _previous_setting, true);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sync_product_barcode_primary_mirror() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER product_barcodes_primary_mirror
AFTER INSERT OR UPDATE OR DELETE ON public.product_barcodes
FOR EACH ROW EXECUTE FUNCTION public.sync_product_barcode_primary_mirror();

CREATE OR REPLACE FUNCTION public.enforce_product_barcode_primary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  _tenant_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  _product_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  _barcode_count integer;
  _primary_count integer;
  _old_barcode_count integer;
  _old_primary_count integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE is_primary)
  INTO _barcode_count, _primary_count
  FROM public.product_barcodes
  WHERE tenant_id = _tenant_id AND product_id = _product_id;
  IF _barcode_count > 0 AND _primary_count <> 1 THEN
    RAISE EXCEPTION 'A product barcode set must contain exactly one primary barcode';
  END IF;
  IF TG_OP = 'UPDATE'
    AND (OLD.tenant_id, OLD.product_id) IS DISTINCT FROM (NEW.tenant_id, NEW.product_id)
  THEN
    SELECT count(*), count(*) FILTER (WHERE is_primary)
    INTO _old_barcode_count, _old_primary_count
    FROM public.product_barcodes
    WHERE tenant_id = OLD.tenant_id AND product_id = OLD.product_id;
    IF _old_barcode_count > 0 AND _old_primary_count <> 1 THEN
      RAISE EXCEPTION 'A product barcode set must contain exactly one primary barcode';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_product_barcode_primary() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER product_barcodes_require_primary
AFTER INSERT OR UPDATE OR DELETE ON public.product_barcodes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_barcode_primary();

CREATE OR REPLACE FUNCTION public.inspect_product_barcode_candidates_v1(
  _tenant_id uuid,
  _product_id uuid,
  _barcodes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _result jsonb;
BEGIN
  IF NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Product barcode inspection is forbidden';
  END IF;
  IF _product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.products WHERE tenant_id = _tenant_id AND id = _product_id
  ) THEN
    RAISE EXCEPTION 'Product does not belong to this tenant';
  END IF;
  IF _barcodes IS NULL OR jsonb_typeof(_barcodes) <> 'array' OR jsonb_array_length(_barcodes) > 64 THEN
    RAISE EXCEPTION 'Barcodes must be an array with at most 64 entries';
  END IF;

  WITH raw AS (
    SELECT value, ordinality::integer AS input_index,
      upper(btrim(COALESCE(value->>'barcode',''))) AS normalized,
      lower(btrim(COALESCE(value->>'barcode_type','internal'))) AS barcode_type,
      COALESCE((value->>'is_primary')::boolean, false) AS is_primary
    FROM jsonb_array_elements(_barcodes) WITH ORDINALITY
  ), numbered AS (
    SELECT raw.*,
      row_number() OVER (PARTITION BY normalized ORDER BY input_index) AS occurrence
    FROM raw
  ), inspected AS (
    SELECT numbered.*, existing.product_id AS conflicting_product_id,
      product.name AS conflicting_product_name,
      product.status::text AS conflicting_product_status,
      CASE
        WHEN numbered.normalized !~ '^[!-~]{1,128}$'
          OR numbered.barcode_type NOT IN ('ean_8','ean_13','upc_a','code_128','qr','internal','supplier','legacy')
          OR (numbered.barcode_type = 'ean_8' AND numbered.normalized !~ '^[0-9]{8}$')
          OR (numbered.barcode_type = 'ean_13' AND numbered.normalized !~ '^[0-9]{13}$')
          OR (numbered.barcode_type = 'upc_a' AND numbered.normalized !~ '^[0-9]{12}$')
          THEN 'malformed'
        WHEN numbered.occurrence > 1 THEN 'duplicate_input'
        WHEN existing.product_id IS NOT NULL AND product.status = 'inactive'::public.entity_status
          THEN 'retired_product_conflict'
        WHEN existing.product_id IS NOT NULL THEN 'database_conflict'
        ELSE 'valid'
      END AS state
    FROM numbered
    LEFT JOIN public.product_barcodes existing
      ON existing.tenant_id = _tenant_id
     AND existing.normalized_barcode = numbered.normalized
     AND (_product_id IS NULL OR existing.product_id <> _product_id)
    LEFT JOIN public.products product
      ON product.tenant_id = existing.tenant_id AND product.id = existing.product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'input_index', input_index - 1,
    'barcode', value->>'barcode',
    'normalized_barcode', normalized,
    'barcode_type', barcode_type,
    'is_primary', is_primary,
    'state', state,
    'conflicting_product_id', conflicting_product_id,
    'conflicting_product_name', conflicting_product_name,
    'conflicting_product_status', conflicting_product_status
  ) ORDER BY input_index), '[]'::jsonb)
  INTO _result
  FROM inspected;
  RETURN _result;
END
$$;

REVOKE ALL ON FUNCTION public.inspect_product_barcode_candidates_v1(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspect_product_barcode_candidates_v1(uuid, uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.replace_product_barcodes_v1(
  _tenant_id uuid,
  _product_id uuid,
  _barcodes jsonb,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _canonical jsonb;
  _inspection jsonb;
  _request_hash text;
  _existing public.product_barcode_operations;
  _inserted integer;
  _primary_count integer;
  _previous_setting text;
BEGIN
  IF NOT public.has_any_role(_actor_id, _tenant_id, ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Product barcode replacement is forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE tenant_id = _tenant_id AND id = _product_id) THEN
    RAISE EXCEPTION 'Product does not belong to this tenant';
  END IF;
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'A stable barcode operation ID is required'; END IF;
  IF _barcodes IS NULL OR jsonb_typeof(_barcodes) <> 'array' OR jsonb_array_length(_barcodes) > 64 THEN
    RAISE EXCEPTION 'Barcodes must be an array with at most 64 entries';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'barcode', upper(btrim(COALESCE(value->>'barcode',''))),
    'barcode_type', lower(btrim(COALESCE(value->>'barcode_type','internal'))),
    'is_primary', COALESCE((value->>'is_primary')::boolean, false),
    'sort_order', ordinality - 1
  ) ORDER BY ordinality), '[]'::jsonb)
  INTO _canonical
  FROM jsonb_array_elements(_barcodes) WITH ORDINALITY;

  SELECT count(*) FILTER (WHERE COALESCE((value->>'is_primary')::boolean, false))
  INTO _primary_count FROM jsonb_array_elements(_canonical);
  IF jsonb_array_length(_canonical) > 0 AND _primary_count <> 1 THEN
    RAISE EXCEPTION 'Exactly one primary product barcode is required';
  END IF;

  _inspection := public.inspect_product_barcode_candidates_v1(_tenant_id, _product_id, _canonical);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(_inspection) item WHERE item->>'state' <> 'valid') THEN
    RAISE EXCEPTION 'Product barcode collision or malformed input' USING DETAIL = _inspection::text;
  END IF;

  _request_hash := md5(_canonical::text);
  INSERT INTO public.product_barcode_operations(tenant_id, product_id, operation_id, request_hash, actor_id)
  VALUES (_tenant_id, _product_id, _operation_id, _request_hash, _actor_id)
  ON CONFLICT (tenant_id, operation_id) DO NOTHING;
  GET DIAGNOSTICS _inserted = ROW_COUNT;

  IF _inserted = 0 THEN
    SELECT * INTO _existing
    FROM public.product_barcode_operations
    WHERE tenant_id = _tenant_id AND operation_id = _operation_id
    FOR UPDATE;
    IF _existing.product_id <> _product_id OR _existing.request_hash <> _request_hash THEN
      RAISE EXCEPTION 'Barcode operation ID was already used with different input';
    END IF;
    IF _existing.completed_at IS NULL THEN RAISE EXCEPTION 'Barcode operation did not complete'; END IF;
    RETURN _existing.product_id;
  END IF;

  DELETE FROM public.product_barcodes
  WHERE tenant_id = _tenant_id AND product_id = _product_id;

  INSERT INTO public.product_barcodes(
    tenant_id, product_id, barcode, barcode_type, is_primary, sort_order
  )
  SELECT _tenant_id, _product_id,
    value->>'barcode', value->>'barcode_type', (value->>'is_primary')::boolean,
    (value->>'sort_order')::smallint
  FROM jsonb_array_elements(_canonical);

  _previous_setting := COALESCE(current_setting('zaipos.product_barcode_command', true), '');
  PERFORM set_config('zaipos.product_barcode_command', 'on', true);
  UPDATE public.products product
  SET barcode = primary_barcode.barcode
  FROM (
    SELECT barcode FROM public.product_barcodes
    WHERE tenant_id = _tenant_id AND product_id = _product_id AND is_primary
    LIMIT 1
  ) primary_barcode
  WHERE product.tenant_id = _tenant_id AND product.id = _product_id
    AND product.barcode IS DISTINCT FROM primary_barcode.barcode;
  IF jsonb_array_length(_canonical) = 0 THEN
    UPDATE public.products SET barcode = NULL
    WHERE tenant_id = _tenant_id AND id = _product_id AND barcode IS NOT NULL;
  END IF;
  PERFORM set_config('zaipos.product_barcode_command', _previous_setting, true);

  UPDATE public.product_barcode_operations
  SET completed_at = now()
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (_tenant_id, _actor_id, 'catalogue.product_barcodes_replaced', 'product', _product_id,
    jsonb_build_object(
      'operation_id', _operation_id,
      'barcode_count', jsonb_array_length(_canonical),
      'primary_barcode', (SELECT value->>'barcode' FROM jsonb_array_elements(_canonical) WHERE (value->>'is_primary')::boolean LIMIT 1)
    ));

  RETURN _product_id;
END
$$;

REVOKE ALL ON FUNCTION public.replace_product_barcodes_v1(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_product_barcodes_v1(uuid, uuid, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_product_by_barcode_v1(
  _tenant_id uuid,
  _barcode text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _product_id uuid;
BEGIN
  IF NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Product barcode lookup is forbidden';
  END IF;
  SELECT barcode.product_id INTO _product_id
  FROM public.product_barcodes barcode
  JOIN public.products product
    ON product.tenant_id = barcode.tenant_id AND product.id = barcode.product_id
  WHERE barcode.tenant_id = _tenant_id
    AND barcode.normalized_barcode = upper(btrim(COALESCE(_barcode,'')))
    AND product.status = 'active'
  ORDER BY barcode.is_primary DESC, barcode.sort_order, barcode.id
  LIMIT 1;
  RETURN _product_id;
END
$$;

REVOKE ALL ON FUNCTION public.resolve_product_by_barcode_v1(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_by_barcode_v1(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_product_barcode_conflict_v1(
  _conflict_id uuid,
  _resolution text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _conflict public.product_barcode_conflicts;
BEGIN
  SELECT * INTO _conflict
  FROM public.product_barcode_conflicts
  WHERE id = _conflict_id
  FOR UPDATE;
  IF _conflict.id IS NULL THEN RAISE EXCEPTION 'Barcode conflict does not exist'; END IF;
  IF NOT public.has_any_role(_actor_id, _conflict.tenant_id, ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Barcode conflict resolution is forbidden';
  END IF;
  _resolution := lower(btrim(COALESCE(_resolution, '')));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF _resolution NOT IN ('keep_existing','dismiss') THEN
    RAISE EXCEPTION 'Barcode conflict resolution must be keep_existing or dismiss';
  END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'A stable conflict operation ID is required'; END IF;
  IF _conflict.state <> 'open' THEN
    IF _conflict.details->>'resolution_operation_id' = _operation_id THEN RETURN _conflict.id; END IF;
    RAISE EXCEPTION 'Barcode conflict was already resolved';
  END IF;
  IF _resolution = 'keep_existing' AND _conflict.conflicting_product_id IS NULL THEN
    RAISE EXCEPTION 'Malformed legacy barcode must be dismissed or corrected on the product';
  END IF;

  UPDATE public.product_barcode_conflicts
  SET state = CASE WHEN _resolution = 'dismiss' THEN 'dismissed' ELSE 'resolved' END,
      resolved_at = now(), resolved_by = _actor_id,
      details = details || jsonb_build_object(
        'resolution', _resolution,
        'resolution_operation_id', _operation_id
      )
  WHERE id = _conflict_id;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (_conflict.tenant_id, _actor_id, 'catalogue.product_barcode_conflict_resolved',
    'product_barcode_conflict', _conflict.id,
    jsonb_build_object(
      'operation_id', _operation_id,
      'resolution', _resolution,
      'candidate_product_id', _conflict.candidate_product_id,
      'conflicting_product_id', _conflict.conflicting_product_id,
      'normalized_barcode', _conflict.normalized_barcode
    ));
  RETURN _conflict.id;
END
$$;

REVOKE ALL ON FUNCTION public.resolve_product_barcode_conflict_v1(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_barcode_conflict_v1(uuid, text, text) TO authenticated;

COMMIT;
