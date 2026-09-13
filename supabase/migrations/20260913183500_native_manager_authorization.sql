BEGIN;
-- Authorizes a requested native effect; this record does not claim the local
-- effect completed. Main logs completion separately using authorization_id.
CREATE FUNCTION public.authorize_desktop_action(
  _tenant_id uuid, _branch_id uuid, _action text, _payload_sha256 text, _nonce uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE _id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(auth.uid(),_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN RAISE EXCEPTION 'Branch is not active'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=auth.uid() AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=now())) THEN RAISE EXCEPTION 'User is not active'; END IF;
  IF EXISTS (SELECT 1 FROM public.employees WHERE user_id=auth.uid() AND tenant_id=_tenant_id AND (branch_id IS NULL OR branch_id=_branch_id) AND status='inactive') THEN RAISE EXCEPTION 'Employee is not active'; END IF;
  IF _action IS NULL OR _action NOT IN ('settings','kiosk','download_update','install_update') THEN RAISE EXCEPTION 'Unsupported desktop action'; END IF;
  IF _nonce IS NULL OR _payload_sha256 IS NULL OR _payload_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid desktop payload binding'; END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,metadata)
  VALUES(_tenant_id,auth.uid(),'desktop.action_authorized','desktop_configuration',jsonb_build_object('branch_id',_branch_id,'action',_action,'nonce',_nonce,'payload_sha256',_payload_sha256)) RETURNING id INTO _id;
  RETURN jsonb_build_object('authorization_id',_id,'tenant_id',_tenant_id,'branch_id',_branch_id,'action',_action,'nonce',_nonce,'payload_sha256',_payload_sha256);
END; $$;
REVOKE ALL ON FUNCTION public.authorize_desktop_action(uuid,uuid,text,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.authorize_desktop_action(uuid,uuid,text,text,uuid) TO authenticated;
COMMIT;
