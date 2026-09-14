import { supabase } from '@/integrations/supabase/client';
import { useTenantStore } from '@/stores/tenant';
import type { ManagerAuthorization } from '../../electron/types';

/** Main verifies this session against its compiled server; UI claims are not authority. */
export async function desktopAuthorization(): Promise<ManagerAuthorization> {
  const {tenantId,branchId}=useTenantStore.getState();
  const {data,error}=await supabase.auth.getSession();
  if (error || !data.session?.access_token || !tenantId || !branchId) throw new Error('Sign in and select a business branch before changing desktop settings.');
  return {accessToken:data.session.access_token,tenantId,branchId};
}
