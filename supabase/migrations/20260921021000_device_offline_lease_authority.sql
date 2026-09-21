-- P0 SEC-004 Stage 5: server-issued bounded offline device authority.
-- This migration deliberately does NOT enable offline checkout. It establishes
-- issuance/revocation state that a later native-custody + reconciliation stage
-- must consume before financial mutations may be queued offline.
BEGIN;

CREATE TABLE public.device_offline_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
  lease_hash bytea NOT NULL,
  issued_to uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_offline_leases_expiry CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CONSTRAINT device_offline_leases_revocation CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT device_offline_leases_hash_length CHECK (octet_length(lease_hash) = 32)
);

CREATE UNIQUE INDEX device_offline_leases_active_device_idx
  ON public.device_offline_leases (device_id)
  WHERE revoked_at IS NULL;
CREATE INDEX device_offline_leases_scope_idx
  ON public.device_offline_leases (tenant_id, branch_id, device_id, expires_at);

ALTER TABLE public.device_offline_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_offline_leases FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.issue_device_offline_lease(
  _tenant_id uuid,
  _branch_id uuid,
  _device_uid text,
  _device_credential text
)
RETURNS TABLE(lease_id uuid, lease_token text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _device_id uuid;
  _lease_id uuid := gen_random_uuid();
  _lease_token text := encode(extensions.gen_random_bytes(32), 'hex');
  _issued_at timestamptz := clock_timestamp();
  _expires_at timestamptz;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _device_uid IS NULL OR btrim(_device_uid) = ''
     OR _device_credential IS NULL OR length(_device_credential) <> 64
     OR _device_credential !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Device credential required' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO _device_id
  FROM public.devices d
  WHERE d.tenant_id = _tenant_id
    AND d.branch_id = _branch_id
    AND d.device_uid = btrim(_device_uid)
    AND d.revoked_at IS NULL
    AND d.credential_hash IS NOT NULL
    AND d.credential_hash = extensions.digest(convert_to(_device_credential, 'UTF8'), 'sha256')
  FOR UPDATE;

  IF _device_id IS NULL THEN
    RAISE EXCEPTION 'Device credential rejected' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_branch_role(_user_id, _tenant_id, _branch_id, ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]) THEN
    RAISE EXCEPTION 'Device operator not authorized' USING ERRCODE = '42501';
  END IF;

  -- A device may hold only one current lease. Replacement is explicit and
  -- auditable; old plaintext capabilities become unusable immediately online.
  UPDATE public.device_offline_leases
  SET revoked_at = _issued_at, revoke_reason = 'superseded'
  WHERE device_id = _device_id AND revoked_at IS NULL;

  _expires_at := _issued_at + interval '15 minutes';
  INSERT INTO public.device_offline_leases(id, tenant_id, branch_id, device_id, lease_hash, issued_to, issued_at, expires_at)
  VALUES (_lease_id, _tenant_id, _branch_id, _device_id,
          extensions.digest(convert_to(_lease_token, 'UTF8'), 'sha256'),
          _user_id, _issued_at, _expires_at);

  RETURN QUERY SELECT _lease_id, _lease_token, _expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_device_offline_leases(_device_id uuid, _reason text DEFAULT 'device_revoked')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _tenant_id uuid;
  _branch_id uuid;
  _count integer;
BEGIN
  SELECT d.tenant_id, d.branch_id INTO _tenant_id, _branch_id FROM public.devices d WHERE d.id = _device_id;
  IF _tenant_id IS NULL OR _user_id IS NULL OR NOT public.has_branch_role(_user_id, _tenant_id, _branch_id, ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to revoke offline authority' USING ERRCODE = '42501';
  END IF;
  UPDATE public.device_offline_leases
  SET revoked_at = clock_timestamp(), revoke_reason = COALESCE(NULLIF(btrim(_reason), ''), 'device_revoked')
  WHERE device_id = _device_id AND revoked_at IS NULL;
  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_device_offline_lease(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_device_offline_lease(uuid, uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_device_offline_leases(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_device_offline_leases(uuid, text) TO authenticated;

COMMIT;
