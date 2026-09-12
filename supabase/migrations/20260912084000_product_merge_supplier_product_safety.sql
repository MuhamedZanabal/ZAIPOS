-- Integrate supplier-product procurement catalogue state into duplicate-product merge safety.
--
-- Supplier catalogue operation rows are immutable historical mutation evidence and retain
-- their original product IDs. Active supplier-product mappings are live procurement state:
-- they must be explicitly reconciled or marked inactive before the source product can be
-- retired. Inactive mappings remain historical catalogue evidence on the original source.

BEGIN;

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
  _preview jsonb;
  _blockers jsonb;
BEGIN
  _preview := public.preview_product_merge_base_v1(
    _tenant_id,
    _source_product_id,
    _canonical_product_id
  );
  _blockers := COALESCE(_preview->'blockers', '[]'::jsonb);

  IF EXISTS (
    SELECT 1
    FROM public.modifier_groups mg
    WHERE mg.product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('modifier_groups');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pricing_policy_rules ppr
    WHERE ppr.tenant_id = _tenant_id
      AND ppr.product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('pricing_policy_rules');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_complementaries pc
    WHERE pc.product_id = _source_product_id
       OR pc.complementary_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('product_complementaries');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_components pc
    WHERE pc.parent_product_id = _source_product_id
       OR pc.component_product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('product_components');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inventory_lots il
    WHERE il.tenant_id = _tenant_id
      AND il.product_id = _source_product_id
      AND il.quantity_remaining > 0
  ) THEN
    _blockers := _blockers || jsonb_build_array('inventory_lots');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_inventory_controls pic
    WHERE pic.tenant_id = _tenant_id
      AND pic.product_id = _source_product_id
      AND pic.lot_tracking_enabled
  ) THEN
    _blockers := _blockers || jsonb_build_array('product_inventory_controls');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stocktake_items si
    JOIN public.stocktakes s ON s.id = si.stocktake_id
    WHERE s.tenant_id = _tenant_id
      AND s.status = 'open'
      AND si.product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('stocktake_items');
  END IF;

  -- An active supplier mapping is current procurement configuration. Repointing it
  -- automatically can collide with a canonical supplier mapping/SKU and can silently
  -- inherit terms that require an explicit purchasing decision. Require the operator
  -- to reconcile or inactivate the mapping before duplicate consolidation.
  IF EXISTS (
    SELECT 1
    FROM public.supplier_products sp
    WHERE sp.tenant_id = _tenant_id
      AND sp.product_id = _source_product_id
      AND sp.status = 'active'
  ) THEN
    _blockers := _blockers || jsonb_build_array('supplier_products');
  END IF;

  _preview := jsonb_set(_preview, '{blockers}', _blockers, true);
  _preview := jsonb_set(
    _preview,
    '{can_merge}',
    to_jsonb(jsonb_array_length(_blockers) = 0),
    true
  );

  RETURN _preview;
END;
$$;

REVOKE ALL ON FUNCTION public.preview_product_merge_v1(uuid,uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_product_merge_v1(uuid,uuid,uuid)
  TO authenticated;

COMMENT ON FUNCTION public.preview_product_merge_v1(uuid,uuid,uuid) IS
  'Authoritative duplicate-product merge preview. Blocks merge while live product state, including physical lot stock, enabled lot tracking, open stocktakes, or active supplier-product procurement mappings, remains on the source; immutable historical references are retained.';

COMMIT;
