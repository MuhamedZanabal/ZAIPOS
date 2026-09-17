import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
import {acknowledgeCashSession,readCashSession,recoverCashSession,startCashSessionOperation,type CashSessionRequest} from '@/lib/cashSessionRecovery';
const request:CashSessionRequest={kind:'open',tenant_id:'a9000000-0000-0000-0000-000000000001',branch_id:'b9000000-0000-0000-0000-000000000001',register_id:null,opening_amount:'1.001'};
const session='e9000000-0000-0000-0000-000000000001';
const key='zaipos:cash-session:v1:actor';
beforeEach(()=>{
 vi.restoreAllMocks();vi.clearAllMocks();localStorage.clear();
 let queue=Promise.resolve();
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(_key:string,fn:()=>Promise<unknown>)=>{const next=queue.then(fn);queue=next.then(()=>undefined,()=>undefined);return next;}}});
 mocks.rpc.mockImplementation(async(_name,args)=>({data:{operation_id:args._operation_id,state:'recorded',session_id:session},error:null}));
});
it('saves the original identity and exact amount before network, then recovers after module restart',async()=>{
 mocks.rpc.mockImplementationOnce(async(_name,args)=>{
  const persisted=JSON.parse(localStorage.getItem(key)!);expect(persisted.operationId).toBe(args._operation_id);expect(persisted.request.opening_amount).toBe('1.001');throw new Error('response lost');
 });
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow('response lost');
 const original=mocks.rpc.mock.calls[0];
 vi.resetModules();const restarted=await import('@/lib/cashSessionRecovery');
 expect((await restarted.recoverCashSession('actor')).sessionId).toBe(session);
 expect(mocks.rpc.mock.calls[1]).toEqual(original);
});
it('serializes competing windows without replacing pending or recorded intent',async()=>{
 const results=await Promise.allSettled([startCashSessionOperation('actor',request),startCashSessionOperation('actor',{...request,opening_amount:'2.002'})]);
 expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(mocks.rpc).toHaveBeenCalledTimes(1);
 expect(readCashSession('actor')?.request).toEqual(request);
});
it('requires a proven terminal outcome before acknowledging or changing a saved request',async()=>{
 mocks.rpc.mockRejectedValueOnce(new Error('offline'));
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow('offline');
 await expect(acknowledgeCashSession('actor')).rejects.toThrow('Recover or resolve');
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow('saved session request');
 const id=readCashSession('actor')?.operationId;
 await recoverCashSession('actor');await acknowledgeCashSession('actor');
 const next=await startCashSessionOperation('actor',request);expect(next.operationId).not.toBe(id);
});
it('retains original closing counts after response loss and subsequent recovery',async()=>{
 const close:CashSessionRequest={kind:'close',tenant_id:request.tenant_id,branch_id:request.branch_id,session_id:session,counted_cash:'1.001',counted_card:'2.002',counted_transfer:'0.000',counted_qr:'3.003',notes:null};
 mocks.rpc.mockRejectedValueOnce(new Error('response lost'));
 await expect(startCashSessionOperation('actor',close)).rejects.toThrow('response lost');
 expect(readCashSession('actor')?.request).toEqual(close);
 await recoverCashSession('actor');expect(mocks.rpc.mock.calls[1]).toEqual(mocks.rpc.mock.calls[0]);
});
it('fails closed on corrupt, empty or unavailable persistence and missing lock support',async()=>{
 for(const raw of ['','{','{"version":1}']) {localStorage.setItem(key,raw);await expect(startCashSessionOperation('actor',request)).rejects.toThrow('unreadable');}
 localStorage.clear();const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('disk unavailable');});
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow('disk unavailable');spy.mockRestore();
 Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow('coordinate session recovery');expect(mocks.rpc).not.toHaveBeenCalled();
});
it('preserves pending identity if the response receipt cannot be saved',async()=>{
 const write=Storage.prototype.setItem;
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(k,v){if(JSON.parse(v).state==='recorded')throw new Error('disk full');write.call(this,k,v);});
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow('disk full');
 expect(readCashSession('actor')?.state).toBe('pending');expect(readCashSession('actor')?.operationId).toBe(mocks.rpc.mock.calls[0][1]._operation_id);
});
it('observes record or cancellation without locally undoing a committed operation',async()=>{
 mocks.rpc.mockRejectedValueOnce(new Error('lost'));
 await expect(startCashSessionOperation('actor',request)).rejects.toThrow();
 expect((await recoverCashSession('actor',true)).state).toBe('recorded');
 expect(mocks.rpc.mock.calls[1][1]._cancel).toBe(true);
 await acknowledgeCashSession('actor');
 mocks.rpc.mockRejectedValueOnce(new Error('lost'));await expect(startCashSessionOperation('actor',request)).rejects.toThrow();
 mocks.rpc.mockImplementationOnce(async(_name,args)=>({data:{operation_id:args._operation_id,state:'cancelled',session_id:null},error:null}));
 expect((await recoverCashSession('actor',true)).state).toBe('cancelled');
});
it('retains pending data for denied access and rejects forged receipt identity',async()=>{
 mocks.rpc.mockResolvedValueOnce({error:{message:'Forbidden'},data:null});
 await expect(startCashSessionOperation('actor',request)).rejects.toMatchObject({message:'Forbidden'});
 mocks.rpc.mockResolvedValueOnce({data:{operation_id:'wrong',state:'recorded',session_id:session},error:null});
 await expect(recoverCashSession('actor')).rejects.toThrow('Unrecognized');expect(readCashSession('actor')?.state).toBe('pending');
 expect(readCashSession('other')).toBeNull();await expect(recoverCashSession('other')).rejects.toThrow('No saved');
});
it('only a server-proven immutable identity conflict is terminal rejection',async()=>{
 mocks.rpc.mockResolvedValueOnce({error:{code:'ZS001',message:'different actor or payload'},data:null});
 expect((await startCashSessionOperation('actor',request)).state).toBe('rejected');await acknowledgeCashSession('actor');expect(readCashSession('actor')).toBeNull();
});
