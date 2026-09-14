import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ handlers:new Map<string, (...args:any[])=>Promise<any>>(), log:vi.fn() }));
vi.mock('../../../electron/security',()=>({ handleTrustedIpc:(channel:string,handler:(...args:any[])=>Promise<any>)=>mocks.handlers.set(channel,handler) }));
vi.mock('../../../electron/logger',()=>({log:mocks.log}));
import { handleManagerIpc } from '../../../electron/manager-authorization';
const auth={accessToken:'contract-token-sentinel',tenantId:'11000000-0000-0000-0000-000000000001',branchId:'21000000-0000-0000-0000-000000000001'};
describe('native manager authority',()=>{
 beforeEach(()=>{mocks.handlers.clear();mocks.log.mockClear();vi.unstubAllGlobals();vi.stubEnv('VITE_SUPABASE_URL','https://contract.supabase.co');vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','public-contract-key');});
 it('rejects absent identity before effects or network',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const effect=vi.fn();handleManagerIpc('test','settings',effect);
  await expect(mocks.handlers.get('test')!({}, {}, undefined)).rejects.toThrow(/manager authorization/i);
  expect(fetcher).not.toHaveBeenCalled();expect(effect).not.toHaveBeenCalled();
 });
 it.each([401,403,500])('denies HTTP %s before persistence',async(status)=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('sensitive server diagnostic',{status})));const effect=vi.fn();handleManagerIpc('test','settings',effect);
  await expect(mocks.handlers.get('test')!({}, {},auth)).rejects.toThrow(/manager authorization/i);expect(effect).not.toHaveBeenCalled();
 });
 it('requires a fresh nonce and payload binding',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({authorized:true,nonce:'old',payload_sha256:'wrong'})));const effect=vi.fn();handleManagerIpc('test','settings',effect);
  await expect(mocks.handlers.get('test')!({}, {},auth)).rejects.toThrow(/manager authorization/i);expect(effect).not.toHaveBeenCalled();
 });
 it('runs effects only after server confirms this request',async()=>{
  const fetcher=vi.fn(async(_url,options)=>{const p=JSON.parse(options.body);return Response.json({authorization_id:'41000000-0000-0000-0000-000000000001',nonce:p._nonce,payload_sha256:p._payload_sha256,action:p._action,tenant_id:p._tenant_id,branch_id:p._branch_id});});vi.stubGlobal('fetch',fetcher);
  const effect=vi.fn(async()=>({ok:true}));handleManagerIpc('test','settings',effect);
  await expect(mocks.handlers.get('test')!({}, {kiosk:false},auth)).resolves.toEqual({ok:true});
  expect(effect).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer contract-token-sentinel');
 });
 it.each([{ok:false},{ok:false,cancelled:true}])('does not report failed/cancelled native effects as completed',async(result)=>{
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const p=JSON.parse(options.body);return Response.json({authorization_id:'41000000-0000-0000-0000-000000000001',nonce:p._nonce,payload_sha256:p._payload_sha256,action:p._action,tenant_id:p._tenant_id,branch_id:p._branch_id});}));
  handleManagerIpc('test','download_update',async()=>result);
  await mocks.handlers.get('test')!({},null,auth);
  expect(mocks.log).not.toHaveBeenCalledWith(expect.anything(),'desktop_authorized_action_completed',expect.anything());
  expect(mocks.log).toHaveBeenCalledWith(expect.anything(),result.cancelled?'desktop_authorized_action_cancelled':'desktop_authorized_action_failed',expect.anything());
 });

});
