import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({cashSession:vi.fn(),getSession:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:mocks.getSession}}}));
import { executeCashSession, readCashSessionDraft } from './deviceCashSession';

const tenant='11111111-1111-4111-8111-111111111111', branch='22222222-2222-4222-8222-222222222222';
const request={_tenant_id:tenant,_branch_id:branch,_session_id:null,_register_id:null,_opening_amount:'1.001',_counted_amount:null,_counted_card:null,_counted_transfer:null,_counted_qr:null,_notes:null};
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.getSession.mockResolvedValue({data:{session:{access_token:'token'}},error:null});window.electron={cashSession:mocks.cashSession} as any;Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key:string,fn:()=>unknown)=>fn()}});});

it('persists and reuses a byte-identical operation after a lost response',async()=>{
  mocks.cashSession.mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce('33333333-3333-4333-8333-333333333333');
  await expect(executeCashSession('cashier','open',request)).rejects.toThrow('lost');
  const saved=readCashSessionDraft('cashier');expect(saved?.operationId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(executeCashSession('cashier','open',request)).resolves.toMatch(/3333/);
  expect(mocks.cashSession.mock.calls[1]).toEqual(mocks.cashSession.mock.calls[0]);
  expect(readCashSessionDraft('cashier')).toBeNull();
});

it('fails closed before network when recovery storage is corrupt or request changes',async()=>{
  localStorage.setItem('zaipos:cash-session:v1:cashier','{broken');
  await expect(executeCashSession('cashier','open',request)).rejects.toThrow(/unreadable/);
  expect(mocks.cashSession).not.toHaveBeenCalled();
  localStorage.clear();mocks.cashSession.mockRejectedValueOnce(new Error('lost'));
  await expect(executeCashSession('cashier','open',request)).rejects.toThrow();
  await expect(executeCashSession('cashier','open',{...request,_opening_amount:'2.000'})).rejects.toThrow(/needs recovery/);
  expect(mocks.cashSession).toHaveBeenCalledTimes(1);
});
