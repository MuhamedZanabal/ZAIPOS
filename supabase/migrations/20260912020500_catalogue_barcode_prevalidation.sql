-- Allow barcode candidate inspection before a new product row exists.
-- Existing product IDs remain tenant-bound; unknown IDs are treated as creation candidates.

BEGIN;

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

  -- Product creation flows need to validate barcodes before INSERT. A UUID that
  -- does not exist yet is therefore a valid candidate identity. An identity
  -- already owned by a different tenant must still fail closed.
  IF _product_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.products
    WHERE id = _product_id
      AND tenant_id <> _tenant_id
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
      ON product.tenant_id = existing.tenant_id
     AND product.id = existing.product_id
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

COMMIT;
