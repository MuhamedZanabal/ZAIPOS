import { bhdToFils } from './bahrain';
import { supabase } from '@/integrations/supabase/client';

export type CashMovementRequest = {
  _session_id: string;
  _type: 'in' | 'out';
  _amount: string;
  _reason: string;
  _reference: string;
};
export type CashMovementDraft = {
  version: 1;
  actorId: string;
  request: CashMovementRequest;
  state: 'pending' | 'recorded' | 'cancelled' | 'rejected';
  movementId: string | null;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = (actorId: string) => `zaipos:cash-movement:v1:${actorId}`;
export function validateCashMovement(request: CashMovementRequest) {
  if (!uuid.test(request._session_id)) throw new Error('An identified cash session is required');
  if (!['in', 'out'].includes(request._type)) throw new Error('Invalid cash movement type');
  if (typeof request._amount !== 'string' || bhdToFils(request._amount) <= 0) throw new Error('Enter a positive exact cash amount');
  if (typeof request._reason !== 'string' || request._reason.trim() !== request._reason || request._reason.length < 2 || request._reason.length > 500) throw new Error('Enter a reason of 2 to 500 characters');
  if (typeof request._reference !== 'string' || request._reference.trim() !== request._reference || request._reference.length < 8 || request._reference.length > 128) throw new Error('Enter a unique movement reference of 8 to 128 characters');
}
export function readCashMovement(actorId: string): CashMovementDraft | null {
  const raw = localStorage.getItem(key(actorId));
  if (!raw) {
    for (let index = 0; index < localStorage.length; index++) {
      if (localStorage.key(index)?.startsWith('zaipos:cash-movement-draft:')) {
        throw new Error('An older cash draft needs manager reconciliation. Preserve the saved reference and device data before starting another movement.');
      }
    }
    return null;
  }
  try {
    const draft: CashMovementDraft = JSON.parse(raw);
    if (draft.version !== 1 || draft.actorId !== actorId || !['pending','recorded','cancelled','rejected'].includes(draft.state)) throw new Error();
    validateCashMovement(draft.request);
    if (draft.state === 'recorded' ? !uuid.test(draft.movementId ?? '') : draft.movementId !== null) throw new Error();
    return draft;
  } catch { throw new Error('Cash recovery data is unreadable. Preserve this device data and reconcile with a manager before recording more cash.'); }
}
async function locked<T>(actorId: string, action: () => Promise<T>): Promise<T> {
  if (!actorId) throw new Error('Sign in to record cash');
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate cash recovery. Use the supported desktop application.');
  return navigator.locks.request(key(actorId), action);
}
export async function executeCashMovement(actorId: string, request: CashMovementRequest, cancel = false) {
  validateCashMovement(request);
  return locked(actorId, async () => {
    const previous = readCashMovement(actorId);
    if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('Another cash movement needs recovery. Reopen this screen before continuing.');
    if (previous?.state === 'cancelled' && !cancel) throw new Error('This movement reference is cancelled');
    const draft: CashMovementDraft = previous ?? { version: 1, actorId, request, state: 'pending', movementId: null };
    // The write and read-back must succeed before crossing the network boundary.
    localStorage.setItem(key(actorId), JSON.stringify(draft));
    if (localStorage.getItem(key(actorId)) !== JSON.stringify(draft)) throw new Error('Cash recovery data could not be saved');
    const {data, error} = cancel
      ? await supabase.rpc('cancel_cash_movement_v2' as never, request as never)
      : await supabase.rpc('record_cash_movement_v2' as never, request as never);
    if (error) {
      // The server's immutable reference binding proves this different request
      // could not have committed. Preserve that outcome before allowing a new voucher.
      if (error.code === 'ZC001') {
        const rejected: CashMovementDraft = {...draft, state: 'rejected', movementId: null};
        localStorage.setItem(key(actorId), JSON.stringify(rejected));
        return rejected;
      }
      throw error;
    }
    if (data !== null && (typeof data !== 'string' || !uuid.test(data))) throw new Error('Unrecognized cash receipt; retry the saved reference');
    if (!cancel && data === null) throw new Error('Missing cash receipt; retry the saved reference');
    const completed: CashMovementDraft = {...draft, state: data ? 'recorded' : 'cancelled', movementId: data};
    localStorage.setItem(key(actorId), JSON.stringify(completed));
    return completed;
  });
}
export async function clearCompletedCashMovement(actorId: string) {
  return locked(actorId, async () => {
    const draft = readCashMovement(actorId);
    if (draft?.state === 'pending') throw new Error('Recover or cancel the original movement first');
    localStorage.removeItem(key(actorId));
  });
}
