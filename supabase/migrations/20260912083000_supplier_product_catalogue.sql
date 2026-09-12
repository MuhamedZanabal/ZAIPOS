-- ZAIPOS P1 authoritative supplier-product procurement catalogue.
--
-- Production boundaries:
-- * exact current supplier cost is integer fils only
-- * pack quantity is integer milli-units only
-- * mutations are server-authoritative, payload-bound and idempotent
-- * authenticated clients cannot write catalogue or operation ledgers directly
-- * tenant/branch/supplier/product structural integrity is enforced by composite FKs
-- * mutable current catalogue terms remain separate from immutable historical PO/cost evidence

BEGIN;

CREATE TABLE public.supplier_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_sku text NOT NULL,
  supplier_product_name text NOT NULL,
  pack_quantity_milli bigint NOT NULL CHECK (pack_quantity_milli > 0),
  current_cost_fils bigint NOT NULL CHECK (current_cost_fils >= 0),
  lead_time_days integer NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  is_preferred boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_products_supplier_sku_not_blank CHECK (length(btrim(supplier_sku)) > 0),
  CONSTRAINT supplier_products_name_not_blank CHECK (length(btrim(supplier_product_name)) > 0),
  CONSTRAINT supplier_products_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_products_tenant_supplier_fkey
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_products_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX supplier_products_mapping_key
  ON public.supplier_products(tenant_id, branch_id, supplier_id, product_id);
CREATE UNIQUE INDEX supplier_products_supplier_sku_key
  ON public.supplier_products(tenant_id, branch_id, supplier_id, lower(btrim(supplier_sku)));
CREATE UNIQUE INDEX supplier_products_one_active_preferred
  ON public.supplier_products(tenant_id, branch_id, product_id)
  WHERE status = 'active' AND is_preferred;
CREATE INDEX supplier_products_branch_supplier_idx
  ON public.supplier_products(tenant_id, branch_id, supplier_id, product_id);
CREATE INDEX supplier_products_branch_product_idx
  ON public.supplier_products(tenant_id, branch_id, product_id, supplier_id);

CREATE TABLE public.supplier_product_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  product_id uuid NOT NULL,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  supplier_product_id uuid REFERENCES public.supplier_products(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT supplier_product_operations_operation_id_check CHECK (length(btrim(operation_id)) >= 8),
  CONSTRAINT supplier_product_operations_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_product_operations_tenant_supplier_fkey
    FOREIGN KEY (tenant_id, supplier_id)
    REFERENCES public.suppliers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_product_operations_tenant_product_fkey
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT supplier_product_operations_tenant_operation_key
    UNIQUE (tenant_id, operation_id)
);

ALTER TABLE public.supplier_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_product_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY supplier_products_branch_read ON public.supplier_products
FOR SELECT TO authenticated USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  )
);

CREATE POLICY supplier_product_operations_branch_read ON public.supplier_product_operations
FOR SELECT TO authenticated USING (
  public.has_branch_role(
    auth.uid(), tenant_id, branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  )
);

REVOKE ALL ON public.supplier_products FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.supplier_product_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.supplier_products TO authenticated;
GRANT SELECT ON public.supplier_product_operations TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_supplier_product_operation_internal_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid,
  _product_id uuid,
  _operation_id text,
  _request_payload jsonb,
  _actor_id uuid
)
RETURNS TABLE(operation_row_id uuid, is_replay boolean, supplier_product_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _request_hash text := md5(_request_payload::text);
  _new_id uuid;
  _existing public.supplier_product_operations;
BEGIN
  INSERT INTO public.supplier_product_operations(
    tenant_id, branch_id, supplier_id, product_id, operation_id,
    request_hash, request_payload, actor_id
  ) VALUES(
    _tenant_id, _branch_id, _supplier_id, _product_id, _operation_id,
    _request_hash, _request_payload, _actor_id
  )
  ON CONFLICT (tenant_id, operation_id) DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NOT NULL THEN
    operation_row_id := _new_id;
    is_replay := false;
    supplier_product_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO _existing
  FROM public.supplier_product_operations
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not acquire supplier product operation';
  END IF;
  IF _existing.branch_id IS DISTINCT FROM _branch_id
    OR _existing.supplier_id IS DISTINCT FROM _supplier_id
    OR _existing.product_id IS DISTINCT FROM _product_id
    OR _existing.request_hash IS DISTINCT FROM _request_hash
    OR _existing.request_payload IS DISTINCT FROM _request_payload
  THEN
    RAISE EXCEPTION 'Supplier product operation ID was already used with different input';
  END IF;
  IF _existing.completed_at IS NULL OR _existing.supplier_product_id IS NULL THEN
    RAISE EXCEPTION 'Supplier product operation did not complete';
  END IF;

  operation_row_id := _existing.id;
  is_replay := true;
  supplier_product_id := _existing.supplier_product_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_supplier_product_operation_internal_v1(uuid,uuid,uuid,uuid,text,jsonb,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.upsert_supplier_product_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid,
  _product_id uuid,
  _supplier_sku text,
  _supplier_product_name text,
  _pack_quantity_milli bigint,
  _current_cost_fils bigint,
  _lead_time_days integer,
  _is_preferred boolean,
  _status text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _request jsonb;
  _claim record;
  _supplier_product_id uuid;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _actor_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;

  _supplier_sku := btrim(COALESCE(_supplier_sku, ''));
  _supplier_product_name := btrim(COALESCE(_supplier_product_name, ''));
  _status := lower(btrim(COALESCE(_status, '')));
  _operation_id := btrim(COALESCE(_operation_id, ''));

  IF length(_supplier_sku) = 0 THEN RAISE EXCEPTION 'Supplier SKU is required'; END IF;
  IF length(_supplier_product_name) = 0 THEN RAISE EXCEPTION 'Supplier product name is required'; END IF;
  IF _pack_quantity_milli IS NULL OR _pack_quantity_milli <= 0 THEN
    RAISE EXCEPTION 'Pack quantity must be positive integer milli-units';
  END IF;
  IF _current_cost_fils IS NULL OR _current_cost_fils < 0 THEN
    RAISE EXCEPTION 'Supplier product cost must be nonnegative exact fils';
  END IF;
  IF _lead_time_days IS NULL OR _lead_time_days < 0 THEN
    RAISE EXCEPTION 'Lead time must be a nonnegative integer day count';
  END IF;
  IF _status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'Unsupported supplier product status'; END IF;
  IF _is_preferred IS NULL THEN RAISE EXCEPTION 'Preferred supplier flag is required'; END IF;
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable supplier product operation ID is required'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.suppliers
    WHERE tenant_id = _tenant_id AND id = _supplier_id
  ) THEN RAISE EXCEPTION 'Supplier does not belong to tenant'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE tenant_id = _tenant_id AND id = _product_id
  ) THEN RAISE EXCEPTION 'Product does not belong to tenant'; END IF;

  -- Serialize catalogue decisions for a branch/product so preferred-supplier
  -- replacement and concurrent retries cannot create two preferred mappings.
  PERFORM 1
  FROM public.products
  WHERE tenant_id = _tenant_id AND id = _product_id
  FOR UPDATE;

  _request := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'supplier_id', _supplier_id,
    'product_id', _product_id,
    'supplier_sku', _supplier_sku,
    'supplier_product_name', _supplier_product_name,
    'pack_quantity_milli', _pack_quantity_milli,
    'current_cost_fils', _current_cost_fils,
    'lead_time_days', _lead_time_days,
    'is_preferred', _is_preferred,
    'status', _status
  );

  SELECT * INTO _claim
  FROM public.claim_supplier_product_operation_internal_v1(
    _tenant_id, _branch_id, _supplier_id, _product_id,
    _operation_id, _request, _actor_id
  );
  IF _claim.is_replay THEN RETURN _claim.supplier_product_id; END IF;

  IF _is_preferred AND _status = 'active' THEN
    UPDATE public.supplier_products
    SET is_preferred = false, updated_by = _actor_id, updated_at = now()
    WHERE tenant_id = _tenant_id
      AND branch_id = _branch_id
      AND product_id = _product_id
      AND status = 'active'
      AND is_preferred
      AND supplier_id <> _supplier_id;
  END IF;

  INSERT INTO public.supplier_products(
    tenant_id, branch_id, supplier_id, product_id,
    supplier_sku, supplier_product_name, pack_quantity_milli,
    current_cost_fils, lead_time_days, is_preferred, status,
    created_by, updated_by
  ) VALUES(
    _tenant_id, _branch_id, _supplier_id, _product_id,
    _supplier_sku, _supplier_product_name, _pack_quantity_milli,
    _current_cost_fils, _lead_time_days, _is_preferred, _status,
    _actor_id, _actor_id
  )
  ON CONFLICT (tenant_id, branch_id, supplier_id, product_id) DO UPDATE
  SET supplier_sku = EXCLUDED.supplier_sku,
      supplier_product_name = EXCLUDED.supplier_product_name,
      pack_quantity_milli = EXCLUDED.pack_quantity_milli,
      current_cost_fils = EXCLUDED.current_cost_fils,
      lead_time_days = EXCLUDED.lead_time_days,
      is_preferred = EXCLUDED.is_preferred,
      status = EXCLUDED.status,
      updated_by = _actor_id,
      updated_at = now()
  RETURNING id INTO _supplier_product_id;

  UPDATE public.supplier_product_operations
  SET supplier_product_id = _supplier_product_id, completed_at = now()
  WHERE id = _claim.operation_row_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(
    _tenant_id, _actor_id, 'supplier.product_catalogue_upserted',
    'supplier_products', _supplier_product_id,
    jsonb_build_object(
      'branch_id', _branch_id,
      'supplier_id', _supplier_id,
      'product_id', _product_id,
      'supplier_sku', _supplier_sku,
      'pack_quantity_milli', _pack_quantity_milli,
      'current_cost_fils', _current_cost_fils,
      'lead_time_days', _lead_time_days,
      'is_preferred', _is_preferred,
      'status', _status,
      'operation_id', _operation_id
    )
  );

  RETURN _supplier_product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_supplier_product_v1(uuid,uuid,uuid,uuid,text,text,bigint,bigint,integer,boolean,text,text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_supplier_product_v1(uuid,uuid,uuid,uuid,text,text,bigint,bigint,integer,boolean,text,text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.list_supplier_products_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _supplier_id uuid DEFAULT NULL
)
RETURNS SETOF public.supplier_products
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(
    _actor_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','inventory']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;

  IF _supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers
    WHERE tenant_id = _tenant_id AND id = _supplier_id
  ) THEN RAISE EXCEPTION 'Supplier does not belong to tenant'; END IF;

  RETURN QUERY
  SELECT sp.*
  FROM public.supplier_products sp
  WHERE sp.tenant_id = _tenant_id
    AND sp.branch_id = _branch_id
    AND (_supplier_id IS NULL OR sp.supplier_id = _supplier_id)
  ORDER BY sp.product_id, sp.supplier_id, sp.id;
END;
$$;

REVOKE ALL ON FUNCTION public.list_supplier_products_v1(uuid,uuid,uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_supplier_products_v1(uuid,uuid,uuid)
TO authenticated;

COMMENT ON TABLE public.supplier_products IS
  'Mutable current supplier-product procurement terms. Historical PO and received-cost evidence remains authoritative and immutable elsewhere.';

COMMIT;
