-- Server-controlled employee POS PIN credentials.
-- Argon2id computation happens in the authenticated Edge Function; PostgreSQL
-- owns authorization, device/session scope, rate limits, lockout and audit state.

BEGIN;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_tenant_branch_id_key UNIQUE (tenant_id, branch_id, id);

CREATE TABLE public.employee_pos_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  employee_id uuid NOT NULL UNIQUE,
  pin_hash text,
  legacy_pin text,
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  last_failed_at timestamptz,
  last_verified_at timestamptz,
  pin_changed_at timestamptz,
  last_set_operation_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_pos_credentials_employee_fkey
    FOREIGN KEY (tenant_id, branch_id, employee_id)
    REFERENCES public.employees(tenant_id, branch_id, id) ON DELETE CASCADE,
  CONSTRAINT employee_pos_credentials_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT employee_pos_credentials_secret_check
    CHECK (pin_hash IS NOT NULL OR legacy_pin IS NOT NULL),
  CONSTRAINT employee_pos_credentials_argon2id_check
    CHECK (pin_hash IS NULL OR pin_hash ~ '^[$]argon2id[$]v=19[$]m=19456,t=2,p=1[$][A-Za-z0-9+/]+[$][A-Za-z0-9+/]+$')
);

CREATE INDEX employee_pos_credentials_scope_idx
  ON public.employee_pos_credentials (tenant_id, branch_id, employee_id);
CREATE INDEX employee_pos_credentials_lock_idx
  ON public.employee_pos_credentials (locked_until)
  WHERE locked_until IS NOT NULL;

CREATE TABLE public.employee_pos_pin_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  credential_id uuid NOT NULL REFERENCES public.employee_pos_credentials(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
  cash_session_id uuid REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  outcome text NOT NULL DEFAULT 'started',
  used_legacy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT employee_pos_pin_attempts_operation_key UNIQUE (tenant_id, operation_id),
  CONSTRAINT employee_pos_pin_attempts_outcome_check
    CHECK (outcome IN ('started', 'succeeded', 'failed', 'locked'))
);

CREATE INDEX employee_pos_pin_attempts_employee_time_idx
  ON public.employee_pos_pin_attempts (tenant_id, branch_id, employee_id, created_at DESC);
CREATE INDEX employee_pos_pin_attempts_actor_time_idx
  ON public.employee_pos_pin_attempts (actor_user_id, created_at DESC);

ALTER TABLE public.employee_pos_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_pos_pin_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_pos_credentials, public.employee_pos_pin_attempts
  FROM PUBLIC, anon, authenticated;

-- Preserve an employee PIN first, then the linked profile PIN, for one-time
-- successful verification and conversion by the Edge Function.
INSERT INTO public.employee_pos_credentials (
  tenant_id, branch_id, employee_id, legacy_pin
)
SELECT employee.tenant_id, employee.branch_id, employee.id,
       COALESCE(NULLIF(trim(employee.pin), ''), NULLIF(trim(profile.pin), ''))
FROM public.employees employee
LEFT JOIN public.profiles profile ON profile.id = employee.user_id
WHERE employee.branch_id IS NOT NULL
  AND COALESCE(NULLIF(trim(employee.pin), ''), NULLIF(trim(profile.pin), '')) IS NOT NULL;

ALTER TABLE public.employees DROP COLUMN pin;
ALTER TABLE public.profiles DROP COLUMN pin;

CREATE OR REPLACE FUNCTION public.set_employee_pos_pin_v1(
  _actor_user_id uuid,
  _tenant_id uuid,
  _branch_id uuid,
  _employee_id uuid,
  _pin_hash text,
  _operation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _credential public.employee_pos_credentials;
BEGIN
  IF _actor_user_id IS NULL OR NOT public.has_branch_role(
    _actor_user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','super_admin']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'POS PIN administration is forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.employees
    WHERE id = _employee_id AND tenant_id = _tenant_id
      AND branch_id = _branch_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Active employee was not found in this branch';
  END IF;
  IF _pin_hash IS NULL OR _pin_hash !~
    '^[$]argon2id[$]v=19[$]m=19456,t=2,p=1[$][A-Za-z0-9+/]+[$][A-Za-z0-9+/]+$' THEN
    RAISE EXCEPTION 'Only the approved Argon2id POS PIN format is accepted';
  END IF;
  _operation_id := trim(COALESCE(_operation_id, ''));
  IF length(_operation_id) < 8 THEN
    RAISE EXCEPTION 'A stable POS PIN operation ID is required';
  END IF;

  SELECT * INTO _credential
  FROM public.employee_pos_credentials
  WHERE last_set_operation_id = _operation_id;
  IF FOUND THEN
    IF _credential.employee_id IS DISTINCT FROM _employee_id
       OR _credential.tenant_id IS DISTINCT FROM _tenant_id
       OR _credential.branch_id IS DISTINCT FROM _branch_id
       OR _credential.pin_hash IS DISTINCT FROM _pin_hash THEN
      RAISE EXCEPTION 'POS PIN operation ID conflicts with another request';
    END IF;
    RETURN _credential.id;
  END IF;

  INSERT INTO public.employee_pos_credentials (
    tenant_id, branch_id, employee_id, pin_hash, legacy_pin,
    failed_attempts, locked_until, pin_changed_at, last_set_operation_id, updated_at
  ) VALUES (
    _tenant_id, _branch_id, _employee_id, _pin_hash, NULL,
    0, NULL, now(), _operation_id, now()
  )
  ON CONFLICT (employee_id) DO UPDATE SET
    pin_hash = EXCLUDED.pin_hash,
    legacy_pin = NULL,
    failed_attempts = 0,
    locked_until = NULL,
    last_failed_at = NULL,
    pin_changed_at = now(),
    last_set_operation_id = EXCLUDED.last_set_operation_id,
    updated_at = now()
  RETURNING * INTO _credential;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    _tenant_id, _actor_user_id, 'pos.pin_set', 'employees', _employee_id,
    jsonb_build_object(
      'branch_id', _branch_id,
      'credential_id', _credential.id,
      'operation_id', _operation_id,
      'algorithm', 'argon2id'
    )
  );
  RETURN _credential.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.begin_employee_pos_pin_verification_v1(
  _actor_user_id uuid,
  _tenant_id uuid,
  _branch_id uuid,
  _employee_id uuid,
  _device_uid text,
  _cash_session_id uuid,
  _operation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _credential public.employee_pos_credentials;
  _device public.devices;
  _attempt public.employee_pos_pin_attempts;
  _employee public.employees;
BEGIN
  IF _actor_user_id IS NULL OR NOT public.has_branch_role(
    _actor_user_id, _tenant_id, _branch_id,
    ARRAY['owner','admin','manager','cashier','super_admin']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'POS PIN verification is forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _employee FROM public.employees
  WHERE id = _employee_id AND tenant_id = _tenant_id
    AND branch_id = _branch_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Active employee was not found in this branch'; END IF;

  SELECT * INTO _device FROM public.devices
  WHERE tenant_id = _tenant_id AND branch_id = _branch_id
    AND device_uid = trim(COALESCE(_device_uid, '')) AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registered active POS device is required'; END IF;

  IF _cash_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cash_sessions
    WHERE id = _cash_session_id AND tenant_id = _tenant_id
      AND branch_id = _branch_id AND user_id = _actor_user_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'Open cash session does not match the requesting operator';
  END IF;
  _operation_id := trim(COALESCE(_operation_id, ''));
  IF length(_operation_id) < 8 THEN RAISE EXCEPTION 'A POS PIN attempt operation ID is required'; END IF;

  SELECT * INTO _credential FROM public.employee_pos_credentials
  WHERE employee_id = _employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee does not have a POS PIN'; END IF;

  SELECT * INTO _attempt FROM public.employee_pos_pin_attempts
  WHERE tenant_id = _tenant_id AND operation_id = _operation_id;
  IF FOUND THEN
    IF _attempt.actor_user_id IS DISTINCT FROM _actor_user_id
       OR _attempt.employee_id IS DISTINCT FROM _employee_id
       OR _attempt.device_id IS DISTINCT FROM _device.id
       OR _attempt.cash_session_id IS DISTINCT FROM _cash_session_id THEN
      RAISE EXCEPTION 'POS PIN attempt operation ID conflicts with another request';
    END IF;
  ELSE
    INSERT INTO public.employee_pos_pin_attempts (
      tenant_id, branch_id, credential_id, employee_id, actor_user_id,
      device_id, cash_session_id, operation_id, outcome
    ) VALUES (
      _tenant_id, _branch_id, _credential.id, _employee_id, _actor_user_id,
      _device.id, _cash_session_id, _operation_id,
      CASE WHEN _credential.locked_until > now() THEN 'locked' ELSE 'started' END
    ) RETURNING * INTO _attempt;
  END IF;

  IF _credential.locked_until > now() THEN
    RETURN jsonb_build_object(
      'allowed', false, 'attempt_id', _attempt.id,
      'locked_until', _credential.locked_until
    );
  END IF;
  IF _attempt.outcome <> 'started' THEN
    RAISE EXCEPTION 'POS PIN attempt has already completed';
  END IF;
  RETURN jsonb_build_object(
    'allowed', true,
    'attempt_id', _attempt.id,
    'pin_hash', _credential.pin_hash,
    'legacy_pin', _credential.legacy_pin
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_employee_pos_pin_verification_v1(
  _actor_user_id uuid,
  _attempt_id uuid,
  _verified boolean,
  _replacement_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _attempt public.employee_pos_pin_attempts;
  _credential public.employee_pos_credentials;
  _employee public.employees;
  _next_failures smallint;
BEGIN
  SELECT * INTO _attempt FROM public.employee_pos_pin_attempts
  WHERE id = _attempt_id FOR UPDATE;
  IF NOT FOUND OR _attempt.actor_user_id IS DISTINCT FROM _actor_user_id THEN
    RAISE EXCEPTION 'POS PIN attempt is not authorized' USING ERRCODE = '42501';
  END IF;
  IF _attempt.outcome <> 'started' THEN RAISE EXCEPTION 'POS PIN attempt has already completed'; END IF;

  SELECT * INTO _credential FROM public.employee_pos_credentials
  WHERE id = _attempt.credential_id FOR UPDATE;
  SELECT * INTO _employee FROM public.employees WHERE id = _attempt.employee_id;

  IF _verified THEN
    IF _credential.legacy_pin IS NOT NULL THEN
      IF _replacement_hash IS NULL OR _replacement_hash !~
        '^[$]argon2id[$]v=19[$]m=19456,t=2,p=1[$][A-Za-z0-9+/]+[$][A-Za-z0-9+/]+$' THEN
        RAISE EXCEPTION 'Successful legacy verification requires an Argon2id replacement';
      END IF;
      UPDATE public.employee_pos_credentials
      SET pin_hash = _replacement_hash, legacy_pin = NULL, failed_attempts = 0,
          locked_until = NULL, last_failed_at = NULL, last_verified_at = now(),
          pin_changed_at = now(), updated_at = now()
      WHERE id = _credential.id;
    ELSE
      UPDATE public.employee_pos_credentials
      SET failed_attempts = 0, locked_until = NULL, last_failed_at = NULL,
          last_verified_at = now(), updated_at = now()
      WHERE id = _credential.id;
    END IF;
    UPDATE public.employee_pos_pin_attempts
    SET outcome = 'succeeded', used_legacy = _credential.legacy_pin IS NOT NULL,
        completed_at = now()
    WHERE id = _attempt.id;
    INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, metadata)
    VALUES (
      _attempt.tenant_id, _actor_user_id, 'pos.pin_verified', 'employees', _employee.id,
      jsonb_build_object(
        'branch_id', _attempt.branch_id, 'attempt_id', _attempt.id,
        'device_id', _attempt.device_id, 'cash_session_id', _attempt.cash_session_id,
        'role', _employee.role, 'legacy_converted', _credential.legacy_pin IS NOT NULL
      )
    );
    RETURN jsonb_build_object(
      'verified', true, 'employee_id', _employee.id,
      'full_name', _employee.full_name, 'role', _employee.role,
      'branch_id', _attempt.branch_id
    );
  END IF;

  _next_failures := LEAST(_credential.failed_attempts + 1, 5);
  UPDATE public.employee_pos_credentials
  SET failed_attempts = _next_failures,
      locked_until = CASE WHEN _next_failures >= 5 THEN now() + interval '15 minutes' ELSE NULL END,
      last_failed_at = now(), updated_at = now()
  WHERE id = _credential.id
  RETURNING * INTO _credential;
  UPDATE public.employee_pos_pin_attempts
  SET outcome = 'failed', completed_at = now()
  WHERE id = _attempt.id;
  RETURN jsonb_build_object(
    'verified', false,
    'attempts_remaining', GREATEST(5 - _next_failures, 0),
    'locked_until', _credential.locked_until
  );
END
$function$;

REVOKE ALL ON FUNCTION public.set_employee_pos_pin_v1(uuid,uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_employee_pos_pin_verification_v1(uuid,uuid,uuid,uuid,text,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_employee_pos_pin_verification_v1(uuid,uuid,boolean,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_pos_pin_v1(uuid,uuid,uuid,uuid,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_employee_pos_pin_verification_v1(uuid,uuid,uuid,uuid,text,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_employee_pos_pin_verification_v1(uuid,uuid,boolean,text)
  TO service_role;

COMMIT;
