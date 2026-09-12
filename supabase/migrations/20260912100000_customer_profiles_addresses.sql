-- ZAIPOS P1 authoritative customer profiles and Bahrain delivery addresses.
--
-- Boundaries:
-- * authenticated clients retain tenant-scoped reads but no direct customer/address DML
-- * profile/address mutations execute through audited, payload-bound, idempotent commands
-- * loyalty_points remains owned by the loyalty/checkout lifecycle and cannot be edited here
-- * customer/address archival is non-destructive so historical sales keep stable identities
-- * legacy free-form customer addresses remain readable and are backfilled as structured defaults

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS status public.entity_status NOT NULL DEFAULT 'active';

CREATE TABLE public.customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  label text NOT NULL,
  recipient_name text,
  phone text,
  building text,
  road text,
  block text,
  area text,
  city text,
  notes text,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_addresses_label_not_blank CHECK (length(btrim(label)) > 0)
);

CREATE INDEX idx_customer_addresses_customer
  ON public.customer_addresses(tenant_id, customer_id, status, created_at, id);
CREATE UNIQUE INDEX uq_customer_addresses_one_active_default
  ON public.customer_addresses(customer_id)
  WHERE status = 'active' AND is_default;

CREATE TABLE public.customer_profile_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  command text NOT NULL CHECK (command IN ('profile_upsert','profile_archive','address_upsert','address_archive')),
  entity_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_profile_operations_operation_id_check CHECK (length(btrim(operation_id)) >= 8),
  UNIQUE (tenant_id, operation_id)
);
CREATE INDEX idx_customer_profile_operations_customer
  ON public.customer_profile_operations(tenant_id, customer_id, created_at, id);

ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profile_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_addresses_member_select ON public.customer_addresses
FOR SELECT TO authenticated
USING (public.is_tenant_member(auth.uid(), tenant_id));

CREATE POLICY customer_profile_operations_manager_select ON public.customer_profile_operations
FOR SELECT TO authenticated
USING (public.has_any_role(
  auth.uid(), tenant_id,
  ARRAY['owner','admin','manager']::public.app_role[]
));

REVOKE ALL ON public.customer_addresses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.customer_profile_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_addresses TO authenticated;
GRANT SELECT ON public.customer_profile_operations TO authenticated;

-- Keep customer reads available through the existing RLS policy, but close the legacy
-- direct-write path now that controlled commands exist.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.customers FROM authenticated;

-- Upgrade-safe bridge for installations that already store one free-form address.
INSERT INTO public.customer_addresses(
  tenant_id, customer_id, label, recipient_name, phone, notes, is_default, status
)
SELECT c.tenant_id, c.id, 'Legacy', c.name, c.phone, c.address, true, 'active'
FROM public.customers c
WHERE NULLIF(btrim(c.address), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.customer_addresses a
    WHERE a.tenant_id = c.tenant_id AND a.customer_id = c.id AND a.status = 'active'
  );

CREATE OR REPLACE FUNCTION public.resolve_customer_command_tenant_v1(
  _actor_id uuid,
  _customer_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  _tenant_id uuid;
  _membership_count integer;
BEGIN
  SELECT c.tenant_id INTO _tenant_id
  FROM public.customers c
  WHERE c.id = _customer_id;

  IF _tenant_id IS NOT NULL THEN
    IF NOT public.is_tenant_member(_actor_id, _tenant_id) THEN
      RAISE EXCEPTION 'Forbidden: customer belongs to another tenant';
    END IF;
    RETURN _tenant_id;
  END IF;

  SELECT p.default_tenant_id INTO _tenant_id
  FROM public.profiles p
  WHERE p.id = _actor_id
    AND p.default_tenant_id IS NOT NULL
    AND public.is_tenant_member(_actor_id, p.default_tenant_id);

  IF _tenant_id IS NOT NULL THEN RETURN _tenant_id; END IF;

  SELECT count(DISTINCT ur.tenant_id), min(ur.tenant_id::text)::uuid
  INTO _membership_count, _tenant_id
  FROM public.user_roles ur
  WHERE ur.user_id = _actor_id;

  IF _membership_count = 1 THEN RETURN _tenant_id; END IF;
  RAISE EXCEPTION 'No unambiguous tenant context for customer command';
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_customer_command_tenant_v1(uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_customer_profile_operation_internal_v1(
  _tenant_id uuid,
  _operation_id text,
  _command text,
  _entity_id uuid,
  _customer_id uuid,
  _request_payload jsonb,
  _actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _request_hash text := md5(_request_payload::text);
  _inserted uuid;
  _existing public.customer_profile_operations;
BEGIN
  INSERT INTO public.customer_profile_operations(
    tenant_id, operation_id, command, entity_id, customer_id,
    request_hash, request_payload, actor_id
  ) VALUES(
    _tenant_id, _operation_id, _command, _entity_id, _customer_id,
    _request_hash, _request_payload, _actor_id
  )
  ON CONFLICT (tenant_id, operation_id) DO NOTHING
  RETURNING id INTO _inserted;

  IF _inserted IS NOT NULL THEN RETURN false; END IF;

  SELECT * INTO _existing
  FROM public.customer_profile_operations
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Could not acquire customer operation'; END IF;
  IF _existing.command IS DISTINCT FROM _command
    OR _existing.entity_id IS DISTINCT FROM _entity_id
    OR _existing.customer_id IS DISTINCT FROM _customer_id
    OR _existing.request_hash IS DISTINCT FROM _request_hash
    OR _existing.request_payload IS DISTINCT FROM _request_payload
  THEN
    RAISE EXCEPTION 'Customer operation ID was already used with different input';
  END IF;
  IF _existing.completed_at IS NULL THEN
    RAISE EXCEPTION 'Customer operation did not complete';
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_customer_profile_operation_internal_v1(uuid,text,text,uuid,uuid,jsonb,uuid)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.upsert_customer_profile_v1(
  _customer_id uuid,
  _profile jsonb,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _is_replay boolean;
  _name text;
  _phone text;
  _email text;
  _document_number text;
  _address text;
  _unknown text;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _customer_id IS NULL THEN RAISE EXCEPTION 'Customer ID is required'; END IF;
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer operation ID is required'; END IF;
  IF _profile IS NULL OR jsonb_typeof(_profile) <> 'object' THEN RAISE EXCEPTION 'Customer profile payload must be an object'; END IF;

  SELECT key INTO _unknown
  FROM jsonb_object_keys(_profile) key
  WHERE key NOT IN ('name','phone','email','document_number','address')
  LIMIT 1;
  IF _unknown IS NOT NULL THEN RAISE EXCEPTION 'Unsupported customer profile field: %', _unknown; END IF;

  _tenant_id := public.resolve_customer_command_tenant_v1(_actor_id, _customer_id);
  IF NOT public.has_any_role(
    _actor_id, _tenant_id,
    ARRAY['owner','admin','manager','cashier','staff']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden'; END IF;

  _name := btrim(COALESCE(_profile->>'name', ''));
  IF length(_name) = 0 THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  _phone := NULLIF(btrim(COALESCE(_profile->>'phone','')), '');
  _email := NULLIF(lower(btrim(COALESCE(_profile->>'email',''))), '');
  _document_number := NULLIF(btrim(COALESCE(_profile->>'document_number','')), '');
  _address := NULLIF(btrim(COALESCE(_profile->>'address','')), '');

  _request := jsonb_build_object(
    'customer_id', _customer_id, 'name', _name, 'phone', _phone,
    'email', _email, 'document_number', _document_number, 'address', _address
  );
  _is_replay := public.claim_customer_profile_operation_internal_v1(
    _tenant_id, _operation_id, 'profile_upsert', _customer_id, _customer_id, _request, _actor_id
  );
  IF _is_replay THEN RETURN _customer_id; END IF;

  INSERT INTO public.customers(id, tenant_id, name, phone, email, document_number, address, status)
  VALUES(_customer_id, _tenant_id, _name, _phone, _email, _document_number, _address, 'active')
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      document_number = EXCLUDED.document_number,
      address = EXCLUDED.address,
      status = 'active',
      updated_at = now()
  WHERE public.customers.tenant_id = _tenant_id;

  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = _customer_id AND c.tenant_id = _tenant_id) THEN
    RAISE EXCEPTION 'Customer belongs to another tenant';
  END IF;

  UPDATE public.customer_profile_operations SET completed_at = now()
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_actor_id,'customer_profile_upsert','customers',_customer_id,
    jsonb_build_object('operation_id',_operation_id,'profile',_request));
  RETURN _customer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_customer_address_v1(
  _customer_id uuid,
  _address_id uuid,
  _address jsonb,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _is_replay boolean;
  _label text;
  _recipient_name text;
  _phone text;
  _building text;
  _road text;
  _block text;
  _area text;
  _city text;
  _notes text;
  _is_default boolean;
  _unknown text;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _customer_id IS NULL OR _address_id IS NULL THEN RAISE EXCEPTION 'Customer and address IDs are required'; END IF;
  _operation_id := btrim(COALESCE(_operation_id, ''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer address operation ID is required'; END IF;
  IF _address IS NULL OR jsonb_typeof(_address) <> 'object' THEN RAISE EXCEPTION 'Customer address payload must be an object'; END IF;

  SELECT key INTO _unknown
  FROM jsonb_object_keys(_address) key
  WHERE key NOT IN ('label','recipient_name','phone','building','road','block','area','city','notes','is_default')
  LIMIT 1;
  IF _unknown IS NOT NULL THEN RAISE EXCEPTION 'Unsupported customer address field: %', _unknown; END IF;

  SELECT c.tenant_id INTO _tenant_id
  FROM public.customers c
  WHERE c.id = _customer_id AND c.status = 'active'
  FOR UPDATE;
  IF _tenant_id IS NULL THEN RAISE EXCEPTION 'Active customer not found'; END IF;
  IF NOT public.has_any_role(
    _actor_id, _tenant_id,
    ARRAY['owner','admin','manager','cashier','staff']::public.app_role[]
  ) THEN RAISE EXCEPTION 'Forbidden: customer tenant access required'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_addresses a
    WHERE a.id = _address_id AND (a.tenant_id <> _tenant_id OR a.customer_id <> _customer_id)
  ) THEN RAISE EXCEPTION 'Address belongs to another tenant or customer'; END IF;

  _label := btrim(COALESCE(_address->>'label',''));
  IF length(_label) = 0 THEN RAISE EXCEPTION 'Address label is required'; END IF;
  _recipient_name := NULLIF(btrim(COALESCE(_address->>'recipient_name','')), '');
  _phone := NULLIF(btrim(COALESCE(_address->>'phone','')), '');
  _building := NULLIF(btrim(COALESCE(_address->>'building','')), '');
  _road := NULLIF(btrim(COALESCE(_address->>'road','')), '');
  _block := NULLIF(btrim(COALESCE(_address->>'block','')), '');
  _area := NULLIF(btrim(COALESCE(_address->>'area','')), '');
  _city := NULLIF(btrim(COALESCE(_address->>'city','')), '');
  _notes := NULLIF(btrim(COALESCE(_address->>'notes','')), '');
  _is_default := COALESCE((_address->>'is_default')::boolean, false);
  IF NOT EXISTS (
    SELECT 1 FROM public.customer_addresses a
    WHERE a.tenant_id = _tenant_id AND a.customer_id = _customer_id
      AND a.status = 'active' AND a.id <> _address_id
  ) THEN _is_default := true; END IF;

  _request := jsonb_build_object(
    'customer_id',_customer_id,'address_id',_address_id,'label',_label,
    'recipient_name',_recipient_name,'phone',_phone,'building',_building,
    'road',_road,'block',_block,'area',_area,'city',_city,'notes',_notes,'is_default',_is_default
  );
  _is_replay := public.claim_customer_profile_operation_internal_v1(
    _tenant_id,_operation_id,'address_upsert',_address_id,_customer_id,_request,_actor_id
  );
  IF _is_replay THEN RETURN _address_id; END IF;

  IF _is_default THEN
    UPDATE public.customer_addresses
    SET is_default = false, updated_by = _actor_id, updated_at = now()
    WHERE tenant_id = _tenant_id AND customer_id = _customer_id
      AND status = 'active' AND is_default AND id <> _address_id;
  END IF;

  INSERT INTO public.customer_addresses(
    id,tenant_id,customer_id,label,recipient_name,phone,building,road,block,area,city,notes,
    is_default,status,created_by,updated_by
  ) VALUES(
    _address_id,_tenant_id,_customer_id,_label,_recipient_name,_phone,_building,_road,_block,_area,_city,_notes,
    _is_default,'active',_actor_id,_actor_id
  )
  ON CONFLICT (id) DO UPDATE
  SET label=EXCLUDED.label, recipient_name=EXCLUDED.recipient_name, phone=EXCLUDED.phone,
      building=EXCLUDED.building, road=EXCLUDED.road, block=EXCLUDED.block,
      area=EXCLUDED.area, city=EXCLUDED.city, notes=EXCLUDED.notes,
      is_default=EXCLUDED.is_default, status='active', updated_by=_actor_id, updated_at=now()
  WHERE public.customer_addresses.tenant_id = _tenant_id
    AND public.customer_addresses.customer_id = _customer_id;

  UPDATE public.customer_profile_operations SET completed_at = now()
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_actor_id,'customer_address_upsert','customer_addresses',_address_id,
    jsonb_build_object('operation_id',_operation_id,'customer_id',_customer_id,'address',_request));
  RETURN _address_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_customer_address_v1(
  _customer_id uuid,
  _address_id uuid,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _is_replay boolean;
  _was_default boolean;
  _replacement uuid;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer address operation ID is required'; END IF;

  SELECT a.tenant_id, a.is_default INTO _tenant_id, _was_default
  FROM public.customer_addresses a
  WHERE a.id=_address_id AND a.customer_id=_customer_id AND a.status='active'
  FOR UPDATE;
  IF _tenant_id IS NULL THEN RAISE EXCEPTION 'Active customer address not found'; END IF;
  IF NOT public.has_any_role(_actor_id,_tenant_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden: manager role required';
  END IF;

  _request := jsonb_build_object('customer_id',_customer_id,'address_id',_address_id);
  _is_replay := public.claim_customer_profile_operation_internal_v1(
    _tenant_id,_operation_id,'address_archive',_address_id,_customer_id,_request,_actor_id
  );
  IF _is_replay THEN RETURN _address_id; END IF;

  UPDATE public.customer_addresses
  SET status='archived',is_default=false,updated_by=_actor_id,updated_at=now()
  WHERE id=_address_id AND tenant_id=_tenant_id AND customer_id=_customer_id;

  IF _was_default THEN
    SELECT a.id INTO _replacement
    FROM public.customer_addresses a
    WHERE a.tenant_id=_tenant_id AND a.customer_id=_customer_id AND a.status='active'
    ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE;
    IF _replacement IS NOT NULL THEN
      UPDATE public.customer_addresses SET is_default=true,updated_by=_actor_id,updated_at=now()
      WHERE id=_replacement;
    END IF;
  END IF;

  UPDATE public.customer_profile_operations SET completed_at=now()
  WHERE tenant_id=_tenant_id AND operation_id=_operation_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_actor_id,'customer_address_archive','customer_addresses',_address_id,
    jsonb_build_object('operation_id',_operation_id,'customer_id',_customer_id));
  RETURN _address_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_customer_profile_v1(
  _customer_id uuid,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _actor_id uuid := auth.uid();
  _tenant_id uuid;
  _request jsonb;
  _is_replay boolean;
BEGIN
  IF _actor_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  _operation_id := btrim(COALESCE(_operation_id,''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'Stable customer operation ID is required'; END IF;

  SELECT c.tenant_id INTO _tenant_id FROM public.customers c WHERE c.id=_customer_id FOR UPDATE;
  IF _tenant_id IS NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT public.has_any_role(_actor_id,_tenant_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden: manager role required';
  END IF;

  _request := jsonb_build_object('customer_id',_customer_id);
  _is_replay := public.claim_customer_profile_operation_internal_v1(
    _tenant_id,_operation_id,'profile_archive',_customer_id,_customer_id,_request,_actor_id
  );
  IF _is_replay THEN RETURN _customer_id; END IF;

  UPDATE public.customers SET status='inactive',updated_at=now()
  WHERE id=_customer_id AND tenant_id=_tenant_id;
  UPDATE public.customer_addresses
  SET status='archived',is_default=false,updated_by=_actor_id,updated_at=now()
  WHERE customer_id=_customer_id AND tenant_id=_tenant_id AND status='active';

  UPDATE public.customer_profile_operations SET completed_at=now()
  WHERE tenant_id=_tenant_id AND operation_id=_operation_id;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant_id,_actor_id,'customer_profile_archive','customers',_customer_id,
    jsonb_build_object('operation_id',_operation_id));
  RETURN _customer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_customer_profile_v1(uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_customer_address_v1(uuid,uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_customer_address_v1(uuid,uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_customer_profile_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_customer_profile_v1(uuid,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_customer_address_v1(uuid,uuid,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_customer_address_v1(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_customer_profile_v1(uuid,text) TO authenticated;

COMMIT;
