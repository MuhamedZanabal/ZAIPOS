import { bhdToFils, filsToBhd } from './bahrain';
import { supabase } from '@/integrations/supabase/client';

type Scope = { tenant_id: string; branch_id: string };
export type CashSessionRequest = Scope & (
  { kind: 'open'; register_id: string | null; opening_amount: string } |
  { kind: 'close'; session_id: string; counted_cash: string; counted_card: string; counted_transfer: string; counted_qr: string; notes: string | null }
);
export type CashSessionDraft = {
  version: 1; actorId: string; operationId: string; request: CashSessionRequest;
  state: 'pending' | 'recorded' | 'cancelled' | 'rejected'; sessionId: string | null;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = (actor: string) => `zaipos:cash-session:v1:${actor}`;
export function validateCashSessionRequest(request: CashSessionRequest) {
  if (!request || !uuid.test(request.tenant_id) || !uuid.test(request.branch_id)) throw new Error('An identified tenant and branch are required');
  const keys = request.kind === 'open'
    ? ['kind','tenant_id','branch_id','register_id','opening_amount']
    : ['kind','tenant_id','branch_id','session_id','counted_cash','counted_card','counted_transfer','counted_qr','notes'];
  if (Object.keys(request).length !== keys.length || keys.some(k => !(k in request))) throw new Error('Invalid session recovery payload');
  let amounts: string[];
  if (request.kind === 'open') {
    if (request.register_id !== null && !uuid.test(request.register_id)) throw new Error('Invalid register');
    amounts = [request.opening_amount];
  } else if (request.kind === 'close') {
    if (!uuid.test(request.session_id) || (request.notes !== null && (typeof request.notes !== 'string' || request.notes.length > 2000))) throw new Error('Invalid closing evidence');
    amounts = [request.counted_cash, request.counted_card, request.counted_transfer, request.counted_qr];
  } else throw new Error('Invalid session operation');
  for (const value of amounts) {
    if (typeof value !== 'string' || !value.trim() || bhdToFils(value) < 0 || filsToBhd(bhdToFils(value)) !== value) throw new Error('Enter explicit non-negative exact-fils amounts');
  }
}
export function readCashSession(actor: string): CashSessionDraft | null {
  const raw = localStorage.getItem(key(actor));
  if (raw === null) return null;
  try {
    const draft: CashSessionDraft = JSON.parse(raw);
    if (draft.version !== 1 || draft.actorId !== actor || !uuid.test(draft.operationId) || !['pending','recorded','cancelled','rejected'].includes(draft.state)) throw new Error();
    validateCashSessionRequest(draft.request);
    if (draft.state === 'recorded' ? !uuid.test(draft.sessionId ?? '') : draft.sessionId !== null) throw new Error();
    if (draft.state === 'recorded' && draft.request.kind === 'close' && draft.sessionId !== draft.request.session_id) throw new Error();
    return draft;
  } catch { throw new Error('Session recovery data is unreadable. Preserve this device data and reconcile with a manager before opening or closing a register.'); }
}
function save(draft: CashSessionDraft) {
  const raw = JSON.stringify(draft);
  localStorage.setItem(key(draft.actorId), raw);
  if (localStorage.getItem(key(draft.actorId)) !== raw) throw new Error('Session recovery data could not be saved');
}
async function locked<T>(actor: string, action: () => Promise<T>) {
  if (!actor) throw new Error('Sign in to manage cash sessions');
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate session recovery. Use the supported desktop application.');
  return navigator.locks.request(key(actor), action);
}
async function send(draft: CashSessionDraft, cancel: boolean) {
  // Even a known outcome is re-authorized when recovered from the server.
  save(draft);
  const {data,error} = await supabase.rpc('apply_cash_session_v2' as never, {
    _operation_id: draft.operationId, _request: draft.request, _cancel: cancel,
  } as never);
  if (error) {
    if (error.code === 'ZS001') {
      const rejected: CashSessionDraft = {...draft,state:'rejected',sessionId:null};
      save(rejected);return rejected;
    }
    throw error;
  }
  const receipt = data as {operation_id?: string;state?: string;session_id?: string | null} | null;
  if (!receipt || receipt.operation_id !== draft.operationId || !['recorded','cancelled'].includes(receipt.state ?? '') ||
      (receipt.state === 'recorded' ? !uuid.test(receipt.session_id ?? '') : receipt.session_id !== null) ||
      (receipt.state === 'recorded' && draft.request.kind === 'close' && receipt.session_id !== draft.request.session_id)) {
    throw new Error('Unrecognized session receipt; retry the saved request');
  }
  const completed: CashSessionDraft = {...draft,state:receipt.state as 'recorded'|'cancelled',sessionId:receipt.session_id!};
  save(completed);return completed;
}
export async function startCashSessionOperation(actor: string, request: CashSessionRequest) {
  validateCashSessionRequest(request);
  return locked(actor, async () => {
    if (readCashSession(actor)) throw new Error('Resolve and acknowledge the saved session request before starting another');
    // Identity and original payload are persisted before the first request.
    return send({version:1,actorId:actor,operationId:crypto.randomUUID(),request,state:'pending',sessionId:null},false);
  });
}
export async function recoverCashSession(actor: string, cancel = false) {
  return locked(actor, async () => {
    const draft = readCashSession(actor);
    if (!draft) throw new Error('No saved session request');
    return send(draft,cancel);
  });
}
export async function acknowledgeCashSession(actor: string) {
  return locked(actor, async () => {
    if (readCashSession(actor)?.state === 'pending') throw new Error('Recover or resolve cancellation first');
    localStorage.removeItem(key(actor));
    if (localStorage.getItem(key(actor)) !== null) throw new Error('Session recovery receipt could not be acknowledged');
  });
}
