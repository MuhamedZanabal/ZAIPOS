BEGIN;
-- One durable identity for each opening or closing intent, including cancellation.
-- Only terminal outcomes are stored: the session, ledger and audit commit together.
CREATE TABLE public.cash_session_operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('open','close')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  state text NOT NULL CHECK (state IN ('recorded','cancelled')),
  session_id uuid REFERENCES public.cash_sessions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES public.branches(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='recorded' AND session_id IS NOT NULL) OR (state='cancelled' AND session_id IS NULL))
);
CREATE INDEX cash_session_operations_branch_created_idx ON public.cash_session_operations(branch_id,created_at DESC);
ALTER TABLE public.cash_session_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_session_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.cash_session_operations TO authenticated;
CREATE POLICY cash_session_operations_select ON public.cash_session_operations FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','cashier']::public.app_role[])
);
CREATE FUNCTION public.prevent_cash_session_operation_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Cash session operation evidence is immutable'; END; $$;
REVOKE ALL ON FUNCTION public.prevent_cash_session_operation_mutation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER cash_session_operations_immutable BEFORE UPDATE OR DELETE ON public.cash_session_operations
FOR EACH ROW EXECUTE FUNCTION public.prevent_cash_session_operation_mutation();

CREATE FUNCTION public.apply_cash_session_v2(_operation_id uuid,_request jsonb,_cancel boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  _actor uuid:=auth.uid(); _tenant uuid; _branch uuid; _register uuid; _session uuid;
  _kind text; _keys text[]; _amount_keys text[]; _key text; _amount numeric;
  _payload jsonb:=_request; _existing public.cash_session_operations; _result public.cash_sessions;
  _state text; _result_id uuid;
BEGIN
  IF _actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _operation_id IS NULL OR _cancel IS NULL OR jsonb_typeof(_request) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'An operation identity and request are required'; END IF;
  _kind:=_request->>'kind';
  IF _kind='open' THEN
    _keys:=ARRAY['kind','tenant_id','branch_id','register_id','opening_amount'];
    _amount_keys:=ARRAY['opening_amount'];
  ELSIF _kind='close' THEN
    _keys:=ARRAY['kind','tenant_id','branch_id','session_id','counted_cash','counted_card','counted_transfer','counted_qr','notes'];
    _amount_keys:=ARRAY['counted_cash','counted_card','counted_transfer','counted_qr'];
  ELSE RAISE EXCEPTION 'Invalid cash session operation'; END IF;
  IF NOT (_request ?& _keys) OR (_request - _keys)<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid cash session request fields'; END IF;
  IF jsonb_typeof(_request->'tenant_id')<>'string' OR jsonb_typeof(_request->'branch_id')<>'string' THEN RAISE EXCEPTION 'Tenant and branch required'; END IF;
  _tenant:=(_request->>'tenant_id')::uuid; _branch:=(_request->>'branch_id')::uuid;
  IF _tenant IS NULL OR _branch IS NULL OR NOT public.has_branch_role(_actor,_tenant,_branch,ARRAY['owner','admin','manager','cashier']::public.app_role[]) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch AND tenant_id=_tenant AND status='active') THEN RAISE EXCEPTION 'Branch is not active'; END IF;
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=_actor AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=now())) THEN RAISE EXCEPTION 'User is not active'; END IF;
  IF EXISTS(SELECT 1 FROM public.employees WHERE user_id=_actor AND tenant_id=_tenant AND (branch_id IS NULL OR branch_id=_branch) AND status='inactive') THEN RAISE EXCEPTION 'Employee is not active'; END IF;
  _payload:=jsonb_set(jsonb_set(_payload,'{tenant_id}',to_jsonb(_tenant)),'{branch_id}',to_jsonb(_branch));
  FOREACH _key IN ARRAY _amount_keys LOOP
    IF jsonb_typeof(_request->_key)<>'string' OR (_request->>_key)!~'^[0-9]+(\.[0-9]{1,3})?$' THEN RAISE EXCEPTION 'Amounts require explicit non-negative exact-fils decimal strings'; END IF;
    _amount:=(_request->>_key)::numeric;
    -- Canonical exact integer-fils payload binding, with bounded conversion.
    _payload:=jsonb_set(_payload,ARRAY[_key],to_jsonb(public.bhd_numeric_to_fils(_amount)));
  END LOOP;
  IF _kind='open' THEN
    IF jsonb_typeof(_request->'register_id') NOT IN ('string','null') THEN RAISE EXCEPTION 'Invalid register'; END IF;
    _register:=(_request->>'register_id')::uuid;
    _payload:=jsonb_set(_payload,'{register_id}',coalesce(to_jsonb(_register),'null'::jsonb));
  ELSE
    IF jsonb_typeof(_request->'session_id')<>'string' OR jsonb_typeof(_request->'notes') NOT IN ('string','null') OR length(coalesce(_request->>'notes',''))>2000 THEN RAISE EXCEPTION 'Invalid closing evidence'; END IF;
    _session:=(_request->>'session_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.cash_sessions WHERE id=_session AND tenant_id=_tenant AND branch_id=_branch) THEN RAISE EXCEPTION 'Cash session is outside this scope'; END IF;
    _payload:=jsonb_set(_payload,'{session_id}',to_jsonb(_session));
  END IF;
  -- The same lock serializes execute/cancel and every replay, independent of
  -- register status or subsequent activity. No session row is changed on replay.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cash-session:'||_operation_id::text,0));
  SELECT * INTO _existing FROM public.cash_session_operations WHERE id=_operation_id;
  IF FOUND THEN
    IF _existing.requested_by IS DISTINCT FROM _actor OR _existing.tenant_id IS DISTINCT FROM _tenant OR _existing.branch_id IS DISTINCT FROM _branch OR _existing.payload IS DISTINCT FROM _payload THEN
      RAISE EXCEPTION USING ERRCODE='ZS001',MESSAGE='Session operation identity belongs to a different actor or payload';
    END IF;
    RETURN jsonb_build_object('operation_id',_operation_id,'state',_existing.state,'session_id',_existing.session_id);
  END IF;
  IF _cancel THEN
    _state:='cancelled'; _result_id:=NULL;
  ELSE
    IF _kind='open' THEN
      SELECT * INTO _result FROM public.open_cash_session(_tenant,_branch,(_request->>'opening_amount')::numeric,_register);
    ELSE
      SELECT * INTO _result FROM public.close_cash_session(_session,(_request->>'counted_cash')::numeric,_request->>'notes',(_request->>'counted_card')::numeric,(_request->>'counted_transfer')::numeric,(_request->>'counted_qr')::numeric);
    END IF;
    _state:='recorded'; _result_id:=_result.id;
  END IF;
  INSERT INTO public.cash_session_operations(id,tenant_id,branch_id,requested_by,kind,payload,state,session_id)
  VALUES(_operation_id,_tenant,_branch,_actor,_kind,_payload,_state,_result_id);
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
  VALUES(_tenant,_actor,'cash_session.operation_'||_state,'cash_session_operations',_operation_id,
    jsonb_build_object('branch_id',_branch,'kind',_kind,'session_id',_result_id,'operation_id',_operation_id));
  RETURN jsonb_build_object('operation_id',_operation_id,'state',_state,'session_id',_result_id);
END; $$;
REVOKE ALL ON FUNCTION public.apply_cash_session_v2(uuid,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_cash_session_v2(uuid,jsonb,boolean) TO authenticated;
-- Older clients must upgrade; silently manufacturing an identity server-side
-- would make response-loss retries unsafe. Internal hardened primitives remain.
REVOKE ALL ON FUNCTION public.open_cash_session(uuid,uuid,numeric,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.close_cash_session(uuid,numeric,text,numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;
COMMIT;
