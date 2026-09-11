-- Complete duplicate-product merge safety for live catalogue references.
--
-- Historical rows remain attached to their original product IDs. Mutable current
-- stock/barcodes are transferred by the authoritative merge. Live catalogue
-- structures that require an explicit business decision are fail-closed blockers:
-- they must be reconciled before the source product can be made inactive.

BEGIN;

-- Preserve the already-tested base preview logic under a private implementation
-- name, then expose a hardened wrapper at the original RPC signature. Existing
-- merge_duplicate_product_v1 callers continue to invoke preview_product_merge_v1.
ALTER FUNCTION public.preview_product_merge_v1(uuid,uuid,uuid)
  RENAME TO preview_product_merge_base_v1;

REVOKE ALL ON FUNCTION public.preview_product_merge_base_v1(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;

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
  -- The private base function owns tenant/global-manager authorization and the
  -- original held-cart, production-order, and price-override state checks.
  _preview := public.preview_product_merge_base_v1(
    _tenant_id,
    _source_product_id,
    _canonical_product_id
  );
  _blockers := COALESCE(_preview->'blockers', '[]'::jsonb);

  -- Product modifiers are live sellable catalogue configuration. They cannot be
  -- silently moved because the canonical product may have an incompatible group.
  IF EXISTS (
    SELECT 1
    FROM public.modifier_groups mg
    WHERE mg.product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('modifier_groups');
  END IF;

  -- Product-specific pricing policy is current authoritative pricing state.
  -- Require an explicit rule reconciliation instead of inheriting it implicitly.
  IF EXISTS (
    SELECT 1
    FROM public.pricing_policy_rules ppr
    WHERE ppr.tenant_id = _tenant_id
      AND ppr.product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('pricing_policy_rules');
  END IF;

  -- Complementary-product edges are active merchandising relationships. Either
  -- role can carry product-specific intent, so both directions fail closed.
  IF EXISTS (
    SELECT 1
    FROM public.product_complementaries pc
    WHERE pc.product_id = _source_product_id
       OR pc.complementary_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('product_complementaries');
  END IF;

  -- BOM/recipe relationships are operational production configuration. Replacing
  -- a parent and replacing a component have different semantics; neither is safe
  -- to rewrite as a generic duplicate-product side effect.
  IF EXISTS (
    SELECT 1
    FROM public.product_components pc
    WHERE pc.parent_product_id = _source_product_id
       OR pc.component_product_id = _source_product_id
  ) THEN
    _blockers := _blockers || jsonb_build_array('product_components');
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

COMMIT;
