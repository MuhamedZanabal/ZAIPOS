import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({cashMovement:vi.fn(),getSession:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:mocks.getSession}}}));
import {clearCompletedCashMovement,executeCashMovement,readCashMovement,type CashMovementRequest} from '@/lib/cashMovementRecovery';
const request:CashMovementRequest={_tenant_id:'a7000000-0000-4000-8000-000000000001',_branch_id:'b7000000-0000-4000-8000-000000000001',_session_id:'e7000000-0000-0000-0000-000000000001',_type:'in',_amount:'1.001',_reason:'Extra float',_reference:'FLOAT-JOURNAL-001'};
const movement='f7000000-0000-0000-0000-000000000001';
beforeEach(()=>{
 vi.restoreAllMocks();vi.clearAllMocks();localStorage.clear();
 let queue=Promise.resolve();
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(_key:string,callback:()=>Promise<unknown>)=>{const next=queue.then(callback);queue=next.then(()=>undefined,()=>undefined);return next;}}});
 mocks.getSession.mockResolvedValue({data:{session:{access_token:'operator-token'}},error:null});
 mocks.cashMovement.mockResolvedValue(movement);
 window.electron={cashMovement:mocks.cashMovement} as any;
});
it('does not replace a pending payload or clear an uncertain request',async()=>{
 mocks.cashMovement.mockRejectedValueOnce(new Error('response lost'));
 await expect(executeCashMovement('actor',request)).rejects.toThrow('response lost');
 await expect(executeCashMovement('actor',{...request,_amount:'2.002'})).rejects.toThrow('needs recovery');
 await expect(clearCompletedCashMovement('actor')).rejects.toThrow('Recover or cancel');
 expect(readCashMovement('actor')?.request).toEqual(request);expect(mocks.cashMovement).toHaveBeenCalledTimes(1);
});
it('serializes competing local drafts before either can overwrite the journal',async()=>{
 const results=await Promise.allSettled([executeCashMovement('actor',request),executeCashMovement('actor',{...request,_reference:'FLOAT-JOURNAL-002'})]);
 expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(mocks.cashMovement).toHaveBeenCalledTimes(1);
 expect(readCashMovement('actor')?.request._reference).toBe(request._reference);
});
it('blocks missing lock support and unavailable storage before sending',async()=>{
 Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
 await expect(executeCashMovement('actor',request)).rejects.toThrow('coordinate cash recovery');expect(mocks.cashMovement).not.toHaveBeenCalled();
});
it('retains pending identity if saving the committed receipt fails',async()=>{
 const original=Storage.prototype.setItem;
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(k,v){if(JSON.parse(v).state==='recorded')throw new Error('disk full');return original.call(this,k,v);});
 await expect(executeCashMovement('actor',request)).rejects.toThrow('disk full');
 expect(readCashMovement('actor')?.state).toBe('pending');expect(readCashMovement('actor')?.request).toEqual(request);
});
it('treats cancellation returning a movement as recorded, and null as cancelled',async()=>{
 expect((await executeCashMovement('actor',request,true)).state).toBe('recorded');
 await clearCompletedCashMovement('actor');mocks.cashMovement.mockResolvedValueOnce(null);
 expect((await executeCashMovement('actor',{...request,_reference:'FLOAT-JOURNAL-002'},true)).state).toBe('cancelled');
});
it('permits a new intent only after a server-proven reference conflict',async()=>{
 const conflict=Object.assign(new Error('Different immutable request'),{code:'ZC001'});mocks.cashMovement.mockRejectedValueOnce(conflict);
 expect((await executeCashMovement('actor',request)).state).toBe('rejected');
 await clearCompletedCashMovement('actor');expect(readCashMovement('actor')).toBeNull();
});
it('does not silently ignore legacy recovery data or another actor journal',async()=>{
 await executeCashMovement('actor',request);expect(readCashMovement('different')).toBeNull();
 localStorage.setItem('zaipos:cash-movement-draft:old:in','{"reference":"OLD-FLOAT"}');
 expect(()=>readCashMovement('different')).toThrow('older cash draft');
});
