-- Pricing approval covers the full reviewed calculation and its source versions.
-- Existing cost-only command remains an internal primitive for canonical history.
BEGIN;

REVOKE ALL ON FUNCTION public.apply_product_pricing_policy_v1(
  uuid,uuid,uuid,public.sales_channel,bigint,text,text
) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.apply_pricing_batch_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _channel public.sales_channel,
  _previews jsonb,
  _reason text,
  _operation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor uuid := auth.uid();
  _approved jsonb;
  _fresh jsonb;
  _product_id uuid;
  _result jsonb := '[]'::jsonb;
  _replay jsonb;
BEGIN
  IF NOT public.can_manage_pricing_scope_internal_v1(_actor, _tenant_id, _branch_id) THEN
    RAISE EXCEPTION 'Pricing application is forbidden for this tenant or branch';
  END IF;
  IF _previews IS NULL OR jsonb_typeof(_previews) <> 'array' THEN
    RAISE EXCEPTION 'Reviewed pricing previews must be an array';
  END IF;
  IF jsonb_array_length(_previews) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Review between 1 and 100 products per atomic pricing batch';
  END IF;
  _reason := btrim(COALESCE(_reason, ''));
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_reason) NOT BETWEEN 3 AND 500 OR length(_operation_id) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'A reason and stable pricing operation ID are required';
  END IF;
  IF (SELECT count(DISTINCT value->>'product_id') FROM jsonb_array_elements(_previews))
       <> jsonb_array_length(_previews) THEN
    RAISE EXCEPTION 'Each reviewed product must appear exactly once';
  END IF;

  -- Shared by rule activation/deactivation. Product locks also serialize manual
  -- price changes and receipts through the existing financial authority.
  PERFORM pg_advisory_xact_lock(hashtextextended('pricing-policy:' || _tenant_id::text, 0));
  _replay := public.claim_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, 'apply_batch',
    md5(jsonb_build_object('actor', _actor, 'branch', _branch_id, 'channel', _channel,
      'previews', _previews, 'reason', _reason)::text), _actor, NULL, NULL);
  IF _replay IS NOT NULL THEN RETURN _replay; END IF;

  -- Fixed order prevents reversed selection order from deadlocking two batches.
  FOR _product_id IN SELECT (value->>'product_id')::uuid
    FROM jsonb_array_elements(_previews) ORDER BY (value->>'product_id')::uuid
  LOOP
    PERFORM 1 FROM public.products WHERE tenant_id = _tenant_id AND id = _product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product does not belong to this tenant'; END IF;
  END LOOP;

  -- Validate every line before making any price changes; exceptions roll back
  -- the entire batch, operation ledger, price history, and audit together.
  FOR _approved IN SELECT value FROM jsonb_array_elements(_previews)
  LOOP
    _product_id := (_approved->>'product_id')::uuid;
    _fresh := public.preview_product_pricing_v1(_tenant_id, _product_id, _branch_id, _channel);
    IF _approved IS DISTINCT FROM _fresh THEN
      RAISE EXCEPTION 'Stale pricing preview for product %: cost, price, scope, or policy changed; review again', _product_id;
    END IF;
  END LOOP;

  FOR _approved IN SELECT value FROM jsonb_array_elements(_previews)
  LOOP
    _product_id := (_approved->>'product_id')::uuid;
    _result := _result || jsonb_build_array(public.apply_product_pricing_policy_v1(
      _tenant_id, _product_id, _branch_id, _channel, (_approved->>'cost_fils')::bigint,
      _reason, 'batch:' || md5(_operation_id) || ':' || _product_id::text));
  END LOOP;
  PERFORM public.complete_pricing_policy_operation_internal_v1(
    _tenant_id, _operation_id, NULL, NULL, _result);
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES (_tenant_id, _actor, 'catalogue.pricing_batch_applied', 'pricing_policy_operation',
    (SELECT id FROM public.pricing_policy_operations WHERE tenant_id=_tenant_id AND operation_id=_operation_id),
    jsonb_build_object('operation_id', _operation_id, 'branch_id', _branch_id,
      'channel', _channel, 'reason', _reason, 'approved_previews', _previews,
      'result', _result, 'applied_at', clock_timestamp()));
  RETURN _result;
END
$$;

REVOKE ALL ON FUNCTION public.apply_pricing_batch_v1(uuid,uuid,public.sales_channel,jsonb,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_pricing_batch_v1(uuid,uuid,public.sales_channel,jsonb,text,text)
TO authenticated;

CREATE FUNCTION public.preview_pricing_batch_v1(
  _tenant_id uuid, _branch_id uuid, _channel public.sales_channel, _product_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _product uuid;
  _result jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.can_manage_pricing_scope_internal_v1(auth.uid(), _tenant_id, _branch_id) THEN
    RAISE EXCEPTION 'Pricing preview is forbidden for this tenant or branch';
  END IF;
  IF _product_ids IS NULL OR cardinality(_product_ids) NOT BETWEEN 1 AND 100
    OR array_position(_product_ids, NULL) IS NOT NULL
    OR (SELECT count(DISTINCT id) FROM unnest(_product_ids) id) <> cardinality(_product_ids)
  THEN RAISE EXCEPTION 'Select between 1 and 100 distinct products'; END IF;
  FOREACH _product IN ARRAY _product_ids LOOP
    _result := _result || jsonb_build_array(public.preview_product_pricing_v1(
      _tenant_id, _product, _branch_id, _channel));
  END LOOP;
  RETURN _result;
END
$$;
REVOKE ALL ON FUNCTION public.preview_pricing_batch_v1(uuid,uuid,public.sales_channel,uuid[])
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_pricing_batch_v1(uuid,uuid,public.sales_channel,uuid[])
TO authenticated;

COMMIT;
