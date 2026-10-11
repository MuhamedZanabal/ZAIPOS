-- Business types for the guided setup wizard.
-- Adds CAFE and SUPERMARKET to the existing RETAIL/RESTAURANT modes. Existing
-- rows stay valid. The mode can now be changed, but only by the owner, through
-- change_business_mode_v1 (the immutability trigger still blocks direct UPDATEs).

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_business_mode_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_business_mode_check
  CHECK (business_mode IN ('RETAIL', 'RESTAURANT', 'CAFE', 'SUPERMARKET'));

CREATE OR REPLACE FUNCTION public.prevent_tenant_business_mode_change_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.business_mode IS DISTINCT FROM OLD.business_mode
     AND COALESCE(current_setting('zaipos.business_mode_change', true), '') <> 'authorized' THEN
    RAISE EXCEPTION 'Business mode can only be changed by the owner from Settings';
  END IF;
  RETURN NEW;
END; $$;

-- Cafes may enable table service; restaurants always have it.
CREATE OR REPLACE FUNCTION public.assert_restaurant_tenant_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = NEW.tenant_id AND t.status = 'active' AND t.business_mode IN ('RESTAURANT', 'CAFE')
  ) THEN
    RAISE EXCEPTION 'Table service is not available for this business type';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.business_mode_channels_v1(_mode text)
RETURNS public.sales_channel[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE upper(_mode)
    WHEN 'RESTAURANT' THEN ARRAY['pos','tables','talabat','whatsapp','delivery']::public.sales_channel[]
    WHEN 'CAFE' THEN ARRAY['pos','talabat','whatsapp','delivery']::public.sales_channel[]
    ELSE ARRAY['pos','whatsapp']::public.sales_channel[]
  END
$$;

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
  PERFORM pg_advisory_xact_lock(hashtext('zaipos.bootstrap_tenant_v2'));
  IF EXISTS (SELECT 1 FROM public.tenants LIMIT 1) THEN RAISE EXCEPTION 'Bootstrap is closed'; END IF;
  IF length(trim(COALESCE(_business_name, ''))) = 0 THEN RAISE EXCEPTION 'Business name is required'; END IF;
  IF _mode NOT IN ('RETAIL', 'RESTAURANT', 'CAFE', 'SUPERMARKET') THEN RAISE EXCEPTION 'Unsupported business mode'; END IF;

  _slug := trim(both '-' from regexp_replace(lower(_business_name), '[^a-z0-9]+', '-', 'g'));
  INSERT INTO public.tenants(name, slug, currency, tax_rate, business_mode, active_channels)
  VALUES(trim(_business_name), NULLIF(_slug, ''), 'BHD', COALESCE(_tax_rate, 10), _mode,
         public.business_mode_channels_v1(_mode))
  RETURNING id INTO _tenant_id;
  INSERT INTO public.branches(tenant_id,name)
  VALUES(_tenant_id,COALESCE(NULLIF(trim(_branch_name),''),'Main Branch')) RETURNING id INTO _branch_id;
  INSERT INTO public.user_roles(tenant_id,user_id,role,branch_id) VALUES(_tenant_id,_user_id,'owner',NULL);
  INSERT INTO public.cash_registers(tenant_id,branch_id,name) VALUES(_tenant_id,_branch_id,'Register 1');
  UPDATE public.profiles SET default_tenant_id=_tenant_id,default_branch_id=_branch_id,updated_at=now() WHERE id=_user_id;
  tenant_id := _tenant_id; branch_id := _branch_id; RETURN NEXT;
END; $$;

-- Owner-only change of business type. Table service can't be switched off
-- while table orders are still open.
CREATE OR REPLACE FUNCTION public.change_business_mode_v1(_tenant_id uuid, _business_mode text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _mode text := upper(trim(COALESCE(_business_mode, '')));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(auth.uid(), _tenant_id, ARRAY['owner']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only the owner can change the business type' USING ERRCODE = '42501';
  END IF;
  IF _mode NOT IN ('RETAIL', 'RESTAURANT', 'CAFE', 'SUPERMARKET') THEN RAISE EXCEPTION 'Unsupported business mode'; END IF;
  IF _mode NOT IN ('RESTAURANT', 'CAFE') AND EXISTS (
    SELECT 1 FROM public.table_orders o WHERE o.tenant_id = _tenant_id AND o.status::text IN ('open', 'sent_to_cashier')
  ) THEN
    RAISE EXCEPTION 'Close or cancel the open table orders before switching to this business type';
  END IF;
  PERFORM set_config('zaipos.business_mode_change', 'authorized', true);
  UPDATE public.tenants
  SET business_mode = _mode,
      active_channels = public.business_mode_channels_v1(_mode),
      updated_at = now()
  WHERE id = _tenant_id;
  PERFORM set_config('zaipos.business_mode_change', '', true);
  RETURN _mode;
END; $$;

-- Owner/admin assigns a staff role to an existing account (used by the local
-- runtime's user creation and the setup wizard's staff step).
CREATE OR REPLACE FUNCTION public.assign_staff_role_v1(
  _tenant_id uuid, _user_id uuid, _role text, _branch_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _r public.app_role;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(auth.uid(), _tenant_id, ARRAY['owner','admin']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only an owner or admin can add staff' USING ERRCODE = '42501';
  END IF;
  IF _role NOT IN ('admin','manager','cashier','waiter','kitchen','inventory','courier','staff') THEN
    RAISE EXCEPTION 'Unsupported staff role';
  END IF;
  IF _role = 'admin' AND NOT public.has_any_role(auth.uid(), _tenant_id, ARRAY['owner']::public.app_role[]) THEN
    RAISE EXCEPTION 'Only the owner can add an administrator' USING ERRCODE = '42501';
  END IF;
  IF _branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = _branch_id AND b.tenant_id = _tenant_id) THEN
    RAISE EXCEPTION 'Branch does not belong to this business';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = _user_id) THEN RAISE EXCEPTION 'User not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _user_id AND ur.tenant_id <> _tenant_id) THEN
    RAISE EXCEPTION 'That account belongs to another business';
  END IF;
  _r := _role::public.app_role;
  INSERT INTO public.user_roles(tenant_id, user_id, role, branch_id)
  VALUES (_tenant_id, _user_id, _r, _branch_id)
  ON CONFLICT DO NOTHING;
END; $$;

REVOKE ALL ON FUNCTION public.business_mode_channels_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.business_mode_channels_v1(text) TO authenticated;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_v2(text,text,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_v2(text,text,numeric,text) TO authenticated;
REVOKE ALL ON FUNCTION public.change_business_mode_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_business_mode_v1(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.assign_staff_role_v1(uuid,uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_staff_role_v1(uuid,uuid,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.assert_restaurant_tenant_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_tenant_business_mode_change_v1() FROM PUBLIC, anon, authenticated;
