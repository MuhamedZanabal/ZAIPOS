-- Authoritative tenant operating mode. Mode is chosen at bootstrap and immutable.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS business_mode text NOT NULL DEFAULT 'RETAIL'
  CONSTRAINT tenants_business_mode_check CHECK (business_mode IN ('RETAIL', 'RESTAURANT'));

-- The historical active_channels default included `tables` for every tenant,
-- including retail-only deployments. Backfill from authoritative persisted
-- restaurant data instead of that non-discriminating default.
UPDATE public.tenants t
SET business_mode = 'RESTAURANT'
WHERE EXISTS (SELECT 1 FROM public.tables rt WHERE rt.tenant_id = t.id)
   OR EXISTS (SELECT 1 FROM public.table_orders ro WHERE ro.tenant_id = t.id)
   OR EXISTS (SELECT 1 FROM public.table_order_items ri WHERE ri.tenant_id = t.id);

UPDATE public.tenants
SET active_channels = array_remove(active_channels, 'tables'::public.sales_channel)
WHERE business_mode = 'RETAIL';

ALTER TABLE public.tenants
  ALTER COLUMN active_channels SET DEFAULT ARRAY[
    'pos'::public.sales_channel,
    'talabat'::public.sales_channel,
    'whatsapp'::public.sales_channel,
    'delivery'::public.sales_channel
  ];

CREATE OR REPLACE FUNCTION public.prevent_tenant_business_mode_change_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.business_mode IS DISTINCT FROM OLD.business_mode THEN
    RAISE EXCEPTION 'Business mode is immutable';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS tenants_business_mode_immutable ON public.tenants;
CREATE TRIGGER tenants_business_mode_immutable
BEFORE UPDATE OF business_mode ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_business_mode_change_v1();

CREATE OR REPLACE FUNCTION public.assert_restaurant_tenant_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = NEW.tenant_id AND t.status = 'active' AND t.business_mode = 'RESTAURANT'
  ) THEN
    RAISE EXCEPTION 'Restaurant operations are disabled for this tenant';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS tables_require_restaurant_mode ON public.tables;
CREATE TRIGGER tables_require_restaurant_mode BEFORE INSERT OR UPDATE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.assert_restaurant_tenant_v1();
DROP TRIGGER IF EXISTS table_orders_require_restaurant_mode ON public.table_orders;
CREATE TRIGGER table_orders_require_restaurant_mode BEFORE INSERT OR UPDATE ON public.table_orders
FOR EACH ROW EXECUTE FUNCTION public.assert_restaurant_tenant_v1();
DROP TRIGGER IF EXISTS table_order_items_require_restaurant_mode ON public.table_order_items;
CREATE TRIGGER table_order_items_require_restaurant_mode BEFORE INSERT OR UPDATE ON public.table_order_items
FOR EACH ROW EXECUTE FUNCTION public.assert_restaurant_tenant_v1();

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_v2(
  _business_name text,
  _branch_name text,
  _tax_rate numeric,
  _business_mode text
)
RETURNS TABLE(tenant_id uuid, branch_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _user_id uuid := auth.uid();
  _tenant_id uuid;
  _branch_id uuid;
  _mode text := upper(trim(COALESCE(_business_mode, '')));
  _slug text;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  -- Serialize first-run clients before checking global bootstrap state. Without
  -- this transaction lock, two terminals can both observe an empty tenant table
  -- and create conflicting authoritative modes.
  PERFORM pg_advisory_xact_lock(hashtext('zaipos.bootstrap_tenant_v2'));
  IF EXISTS (SELECT 1 FROM public.tenants LIMIT 1) THEN RAISE EXCEPTION 'Bootstrap is closed'; END IF;
  IF length(trim(COALESCE(_business_name, ''))) = 0 THEN RAISE EXCEPTION 'Business name is required'; END IF;
  IF _mode NOT IN ('RETAIL', 'RESTAURANT') THEN RAISE EXCEPTION 'Unsupported business mode'; END IF;

  _slug := trim(both '-' from regexp_replace(lower(_business_name), '[^a-z0-9]+', '-', 'g'));
  INSERT INTO public.tenants(name, slug, currency, tax_rate, business_mode, active_channels)
  VALUES(trim(_business_name), NULLIF(_slug, ''), 'BHD', COALESCE(_tax_rate, 10), _mode,
    CASE WHEN _mode = 'RESTAURANT'
      THEN ARRAY['pos','tables','talabat','whatsapp','delivery']::public.sales_channel[]
      ELSE ARRAY['pos','talabat','whatsapp','delivery']::public.sales_channel[] END)
  RETURNING id INTO _tenant_id;
  INSERT INTO public.branches(tenant_id,name)
  VALUES(_tenant_id,COALESCE(NULLIF(trim(_branch_name),''),'Main Branch')) RETURNING id INTO _branch_id;
  INSERT INTO public.user_roles(tenant_id,user_id,role,branch_id) VALUES(_tenant_id,_user_id,'owner',NULL);
  INSERT INTO public.cash_registers(tenant_id,branch_id,name) VALUES(_tenant_id,_branch_id,'Register 1');
  UPDATE public.profiles SET default_tenant_id=_tenant_id,default_branch_id=_branch_id,updated_at=now() WHERE id=_user_id;
  tenant_id := _tenant_id; branch_id := _branch_id; RETURN NEXT;
END; $$;

REVOKE ALL ON FUNCTION public.bootstrap_first_tenant(text,text,numeric,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_v2(text,text,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_v2(text,text,numeric,text) TO authenticated;
REVOKE ALL ON FUNCTION public.assert_restaurant_tenant_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_tenant_business_mode_change_v1() FROM PUBLIC, anon, authenticated;
