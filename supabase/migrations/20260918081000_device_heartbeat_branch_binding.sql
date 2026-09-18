-- P0: a heartbeat may refresh runtime metadata, but must never move an existing device_uid to another branch.
BEGIN;
CREATE OR REPLACE FUNCTION public.register_device_heartbeat(_tenant_id uuid,_branch_id uuid,_device_uid text,_app_version text,_os text,_update_channel text DEFAULT 'stable',_update_state text DEFAULT 'current',_capabilities jsonb DEFAULT '{}'::jsonb)
RETURNS public.devices LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE result public.devices; existing_branch_id uuid; existing_revoked_at timestamptz;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF _branch_id IS NULL OR NOT public.has_branch_role(auth.uid(),_tenant_id,_branch_id,ARRAY['owner','admin','manager','cashier','kitchen','inventory','staff','waiter','courier']::public.app_role[]) THEN RAISE EXCEPTION 'Not authorized for this tenant and branch' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch_id AND tenant_id=_tenant_id AND status='active') THEN RAISE EXCEPTION 'Active branch does not belong to tenant' USING ERRCODE='23503'; END IF;
 IF char_length(COALESCE(_device_uid,'')) NOT BETWEEN 8 AND 200 OR char_length(COALESCE(_app_version,'')) NOT BETWEEN 1 AND 64 OR char_length(COALESCE(_os,'')) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'Invalid device heartbeat identity'; END IF;
 IF _update_channel NOT IN ('stable','beta') OR _update_state NOT IN ('current','outdated','update_available','downloading','ready','error') OR jsonb_typeof(COALESCE(_capabilities,'{}'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'Invalid device heartbeat state'; END IF;
 SELECT branch_id,revoked_at INTO existing_branch_id,existing_revoked_at FROM public.devices WHERE tenant_id=_tenant_id AND device_uid=_device_uid FOR UPDATE;
 IF existing_revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Device is revoked' USING ERRCODE='42501'; END IF;
 IF existing_branch_id IS NOT NULL AND existing_branch_id IS DISTINCT FROM _branch_id THEN RAISE EXCEPTION 'Device is enrolled to a different branch' USING ERRCODE='42501'; END IF;
 INSERT INTO public.devices(tenant_id,branch_id,device_uid,app_version,os,update_channel,update_state,capabilities,last_seen_at,updated_at)
 VALUES(_tenant_id,_branch_id,_device_uid,_app_version,_os,_update_channel,_update_state,COALESCE(_capabilities,'{}'::jsonb),now(),now())
 ON CONFLICT(tenant_id,device_uid) DO UPDATE SET app_version=EXCLUDED.app_version,os=EXCLUDED.os,update_channel=EXCLUDED.update_channel,update_state=EXCLUDED.update_state,capabilities=EXCLUDED.capabilities,last_seen_at=now(),updated_at=now()
 RETURNING * INTO result;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.register_device_heartbeat(uuid,uuid,text,text,text,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_device_heartbeat(uuid,uuid,text,text,text,text,text,jsonb) TO authenticated;
COMMIT;
