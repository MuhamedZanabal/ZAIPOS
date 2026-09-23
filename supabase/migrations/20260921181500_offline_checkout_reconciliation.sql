-- P0 SEC-004 Stage 7: lease-bound, exactly-once offline checkout reconciliation.
-- Offline execution remains disabled. This RPC only reconciles an immutable
-- checkout captured under a previously issued bounded device lease after the
-- terminal is online and authenticated again.
BEGIN;

CREATE TABLE public.offline_checkout_reconciliations (
  mutation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
  lease_id uuid NOT NULL REFERENCES public.device_offline_leases(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT offline_checkout_reconciliations_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT offline_checkout_reconciliations_state_check CHECK (
    (status = 'processing' AND sale_id IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND sale_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX offline_checkout_reconciliations_scope_idx
  ON public.offline_checkout_reconciliations(tenant_id, branch_id, device_id, created_at DESC);

ALTER TABLE public.offline_checkout_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.offline_checkout_reconciliations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_offline_checkout(
  _tenant_id uuid,
  _branch_id uuid,
  _lease_id uuid,
  _lease_token text,
  _device_uid text,
  _mutation_id uuid,
  _items jsonb,
  _payments jsonb,
  _discount_total_fils bigint DEFAULT 0,
  _notes text DEFAULT NULL,
  _customer_id uuid DEFAULT NULL,
  _channel public.sales_channel DEFAULT 'pos',
  _tip_amount_fils bigint DEFAULT 0,
  _coupon_code text DEFAULT NULL,
  _cash_session_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _device_id uuid;
  _lease public.device_offline_leases;
  _existing public.offline_checkout_reconciliations;
  _request_payload jsonb;
  _sale_id uuid;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _mutation_id IS NULL OR _lease_id IS NULL
     OR _device_uid IS NULL OR btrim(_device_uid) = ''
     OR _lease_token IS NULL OR length(_lease_token) <> 64
     OR _lease_token !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Offline reconciliation authority is malformed' USING ERRCODE = '42501';
  END IF;

  -- Resolve the physical terminal independently from caller-supplied lease data.
  SELECT d.id INTO _device_id
  FROM public.devices d
  WHERE d.tenant_id = _tenant_id
    AND d.branch_id = _branch_id
    AND d.device_uid = btrim(_device_uid)
    AND d.revoked_at IS NULL
  FOR UPDATE;

  IF _device_id IS NULL THEN
    RAISE EXCEPTION 'Offline reconciliation device rejected' USING ERRCODE = '42501';
  END IF;

  -- Possession of a lease UUID is never authority. Verify the one-time plaintext
  -- capability against the server-side SHA-256 verifier and bind every scope.
  SELECT l.* INTO _lease
  FROM public.device_offline_leases l
  WHERE l.id = _lease_id
    AND l.tenant_id = _tenant_id
    AND l.branch_id = _branch_id
    AND l.device_id = _device_id
  FOR UPDATE;

  IF NOT FOUND
     OR _lease.revoked_at IS NOT NULL
     OR _lease.expires_at <= clock_timestamp()
     OR _lease.lease_hash IS DISTINCT FROM extensions.digest(convert_to(_lease_token, 'UTF8'), 'sha256') THEN
    RAISE EXCEPTION 'Offline lease rejected' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_branch_role(
    _user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','cashier','waiter']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Offline reconciliation operator not authorized' USING ERRCODE = '42501';
  END IF;

  _request_payload := jsonb_build_object(
    'tenant_id', _tenant_id,
    'branch_id', _branch_id,
    'lease_id', _lease_id,
    'device_id', _device_id,
    'items', _items,
    'payments', COALESCE(_payments, '[]'::jsonb),
    'discount_total_fils', COALESCE(_discount_total_fils, 0),
    'notes', _notes,
    'customer_id', _customer_id,
    'channel', _channel::text,
    'tip_amount_fils', COALESCE(_tip_amount_fils, 0),
    'coupon_code', NULLIF(upper(trim(COALESCE(_coupon_code, ''))), ''),
    'cash_session_id', _cash_session_id
  );

  SELECT * INTO _existing
  FROM public.offline_checkout_reconciliations
  WHERE mutation_id = _mutation_id
  FOR UPDATE;

  IF FOUND THEN
    IF _existing.tenant_id <> _tenant_id
       OR _existing.branch_id <> _branch_id
       OR _existing.device_id <> _device_id
       OR _existing.lease_id <> _lease_id
       OR _existing.request_payload IS DISTINCT FROM _request_payload THEN
      RAISE EXCEPTION 'Offline mutation ID was already used for different authority or payload';
    END IF;
    IF _existing.status = 'completed' AND _existing.sale_id IS NOT NULL THEN
      RETURN _existing.sale_id;
    END IF;
    RAISE EXCEPTION 'Offline reconciliation is already processing';
  END IF;

  INSERT INTO public.offline_checkout_reconciliations(
    mutation_id, tenant_id, branch_id, device_id, lease_id, user_id, request_payload
  ) VALUES (
    _mutation_id, _tenant_id, _branch_id, _device_id, _lease_id, _user_id, _request_payload
  );

  -- Delegate every financial invariant to the existing authoritative checkout
  -- implementation. The stable offline mutation UUID becomes its idempotency key;
  -- this function does not implement a second money-changing path.
  _sale_id := public.checkout_sale_v2(
    _tenant_id,
    _branch_id,
    _items,
    COALESCE(_payments, '[]'::jsonb),
    COALESCE(_discount_total_fils, 0),
    _notes,
    _customer_id,
    _channel,
    COALESCE(_tip_amount_fils, 0),
    _coupon_code,
    _mutation_id::text,
    _cash_session_id
  );

  UPDATE public.offline_checkout_reconciliations
  SET status = 'completed', sale_id = _sale_id, completed_at = clock_timestamp()
  WHERE mutation_id = _mutation_id;

  RETURN _sale_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_offline_checkout(uuid, uuid, uuid, text, text, uuid, jsonb, jsonb, bigint, text, uuid, public.sales_channel, bigint, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_offline_checkout(uuid, uuid, uuid, text, text, uuid, jsonb, jsonb, bigint, text, uuid, public.sales_channel, bigint, text, uuid) TO authenticated;

COMMIT;
