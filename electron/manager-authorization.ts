import { createHash, randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { handleTrustedIpc } from './security.js';
import { log } from './logger.js';
import type { ManagerAuthorization } from './types.js';

export type ManagerAction = 'settings' | 'kiosk' | 'download_update' | 'install_update';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const denied = () => new Error('Online manager authorization is required for this desktop action.');

async function authorize(action: ManagerAction, payload: unknown, input: unknown): Promise<string> {
  const auth = input as ManagerAuthorization | undefined;
  if (!auth || typeof auth.accessToken !== 'string' || auth.accessToken.length < 16 || auth.accessToken.length > 8192 ||
      /\s/.test(auth.accessToken) || !uuid.test(auth.tenantId ?? '') || !uuid.test(auth.branchId ?? '')) throw denied();
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  let endpoint: URL;
  try {
    endpoint = new URL(configuredUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !key) throw denied();
    endpoint.pathname = '/rest/v1/rpc/authorize_desktop_action';
  } catch { throw denied(); }
  const serialized = JSON.stringify(payload ?? null);
  if (serialized.length > 262144) throw denied();
  const payloadHash = createHash('sha256').update(serialized).digest('hex');
  const nonce = randomUUID();
  try {
    const response = await fetch(endpoint, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',apikey:key,Authorization:`Bearer ${auth.accessToken}`},
      body:JSON.stringify({_tenant_id:auth.tenantId,_branch_id:auth.branchId,_action:action,_payload_sha256:payloadHash,_nonce:nonce}),
    });
    if (!response.ok) throw denied();
    const result = await response.json();
    if (!result || !uuid.test(result.authorization_id ?? '') || result.nonce !== nonce || result.payload_sha256 !== payloadHash ||
        result.action !== action || result.tenant_id !== auth.tenantId || result.branch_id !== auth.branchId) throw denied();
    return result.authorization_id;
  } catch { throw denied(); }
}

/** No cached privileges: the trusted main process verifies each sensitive action. */
export function handleManagerIpc(channel: string, action: ManagerAction, handler: (event: IpcMainInvokeEvent, payload: any) => any): void {
  handleTrustedIpc(channel, async (event, payload, authorization) => {
    const authorizationId = await authorize(action, payload, authorization);
    const result = await handler(event, payload);
    const outcome = result?.cancelled ? 'cancelled' : result?.ok === false ? 'failed' : 'completed';
    log(outcome === 'failed' ? 'error' : 'info',`desktop_authorized_action_${outcome}`,{action,authorizationId});
    return result;
  });
}
