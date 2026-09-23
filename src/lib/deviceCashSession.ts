import { supabase } from '@/integrations/supabase/client';

export type CashSessionAction = 'open' | 'close';
export type CashSessionRequest = {
  _tenant_id: string; _branch_id: string; _session_id: string | null;
  _register_id: string | null; _opening_amount: string | null;
  _counted_amount: string | null; _counted_card: string | null;
  _counted_transfer: string | null; _counted_qr: string | null; _notes: string | null;
};
export type CashSessionDraft = { version: 1; actorId: string; action: CashSessionAction; operationId: string; request: CashSessionRequest };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BHD = /^(0|[1-9]\d*)\.\d{3}$/;
const key = (actorId: string) => `zaipos:cash-session:v1:${actorId}`;

function validate(action: CashSessionAction, request: CashSessionRequest) {
  if (!UUID.test(request._tenant_id) || !UUID.test(request._branch_id)) throw new Error('Cash session requires an identified tenant and branch');
  if (action === 'open') {
    if (!BHD.test(request._opening_amount ?? '') || request._session_id !== null) throw new Error('Opening cash must be an exact BHD amount');
    if (request._register_id !== null && !UUID.test(request._register_id)) throw new Error('Invalid cash register');
  } else {
    if (!UUID.test(request._session_id ?? '')) throw new Error('Cash session recovery requires the original session');
    for (const amount of [request._counted_amount,request._counted_card,request._counted_transfer,request._counted_qr]) {
      if (!BHD.test(amount ?? '')) throw new Error('Closing counts must be exact BHD amounts');
    }
    if (request._notes !== null && (request._notes !== request._notes.trim() || request._notes.length > 2000)) throw new Error('Invalid cash session notes');
  }
}

export function readCashSessionDraft(actorId: string): CashSessionDraft | null {
  const raw = localStorage.getItem(key(actorId));
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as CashSessionDraft;
    if (draft.version !== 1 || draft.actorId !== actorId || !['open','close'].includes(draft.action) || !UUID.test(draft.operationId)) throw new Error();
    validate(draft.action, draft.request);
    return draft;
  } catch { throw new Error('Cash-session recovery data is unreadable. Preserve this terminal data and reconcile with a manager.'); }
}

async function locked<T>(actorId: string, action: () => Promise<T>): Promise<T> {
  if (!actorId) throw new Error('Sign in to operate the register');
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate register recovery. Use the supported desktop application.');
  return navigator.locks.request(key(actorId), action);
}

export async function executeCashSession(actorId: string, action: CashSessionAction, request: CashSessionRequest): Promise<string> {
  validate(action, request);
  return locked(actorId, async () => {
    const previous = readCashSessionDraft(actorId);
    if (previous && (previous.action !== action || JSON.stringify(previous.request) !== JSON.stringify(request))) {
      throw new Error('Another register operation needs recovery before starting a different one.');
    }
    const draft: CashSessionDraft = previous ?? { version: 1, actorId, action, operationId: crypto.randomUUID(), request };
    const serialized = JSON.stringify(draft);
    localStorage.setItem(key(actorId), serialized);
    if (localStorage.getItem(key(actorId)) !== serialized) throw new Error('Register recovery data could not be saved');
    if (!window.electron?.cashSession) throw new Error('Register operations require the supported provisioned desktop application');
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('An active authenticated session is required');
    const result = await window.electron.cashSession({ ...request, _operation_id: draft.operationId }, {
      accessToken: data.session.access_token, tenantId: request._tenant_id, branchId: request._branch_id,
    }, action === 'close');
    if (!UUID.test(result)) throw new Error('Register operation returned an invalid identifier');
    localStorage.removeItem(key(actorId));
    return result;
  });
}
