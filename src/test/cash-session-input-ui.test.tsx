import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),error:vi.fn(),session:null as any}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
vi.mock('@/hooks/useTenantContext',()=>({useTenantContext:()=>({tenantId:'a9000000-0000-0000-0000-000000000001',branchId:'b9000000-0000-0000-0000-000000000001',hasRole:()=>true})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({user:{id:'actor'}})}));
vi.mock('@/hooks/useOpenSession',()=>({useOpenSession:()=>({data:mocks.session})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({data:[]}),useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/modules/cash/PendingTableOrders',()=>({PendingTableOrders:()=>null}));
import Cash from '@/modules/cash/Cash';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.session=null;Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(_key:string,fn:()=>unknown)=>fn()}});mocks.rpc.mockImplementation(async(_name,args)=>({data:{operation_id:args._operation_id,state:'recorded',session_id:'e9000000-0000-0000-0000-000000000001'},error:null}));});
it('rejects fractional-fils opening instead of rounding the typed float',async()=>{
 render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.0001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.rpc).not.toHaveBeenCalled();
});
it('sends exact opening decimal text',async()=>{
 render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalled());expect(mocks.rpc.mock.calls[0][1]._request.opening_amount).toBe('1.001');
});
it('requires all blind close counts explicitly, including zero buckets',async()=>{
 mocks.session={id:'e9000000-0000-0000-0000-000000000001',opening_amount:1,total_cash:0,total_card:0,total_transfer:0,total_qr:0,total_in:0,total_out:0};
 render(<Cash/>);fireEvent.click(screen.getByRole('button',{name:/Close register/}));
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Close register'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.rpc).not.toHaveBeenCalled();
});
it('sends each explicitly counted bucket as exact decimal text',async()=>{
 mocks.session={id:'e9000000-0000-0000-0000-000000000001',opening_amount:1,total_cash:0,total_card:0,total_transfer:0,total_qr:0,total_in:0,total_out:0};
 render(<Cash/>);fireEvent.click(screen.getByRole('button',{name:/Close register/}));
 const dialog=within(screen.getByRole('dialog'));
 dialog.getAllByRole('spinbutton').forEach((input,index)=>fireEvent.change(input,{target:{value:index===0?'1.001':'0.000'}}));
 fireEvent.click(dialog.getByRole('button',{name:'Close register'}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalled());
 expect(mocks.rpc.mock.calls[0][1]._request).toMatchObject({counted_cash:'1.001',counted_card:'0.000',counted_transfer:'0.000',counted_qr:'0.000'});
});

it('saves opening intent before sending and recovers the same request after remount',async()=>{
 mocks.rpc.mockImplementation(async()=>{expect(localStorage.getItem('zaipos:cash-session:v1:actor')).not.toBeNull();throw new Error('response lost');});
 const view=render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledTimes(1));
 await waitFor(()=>expect(localStorage.getItem('zaipos:cash-session:v1:actor')).not.toBeNull());
 const first=mocks.rpc.mock.calls[0];view.unmount();render(<Cash/>);
 fireEvent.click(screen.getByRole('button',{name:/Retry saved session request/}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledTimes(2));
 expect(mocks.rpc.mock.calls[1]).toEqual(first);
});
it('recovers original closing counts after the session disappears from the active list',async()=>{
 mocks.session={id:'e9000000-0000-0000-0000-000000000001',opening_amount:1,total_cash:0,total_card:0,total_transfer:0,total_qr:0,total_in:0,total_out:0};
 mocks.rpc.mockRejectedValueOnce(new Error('response lost'));
 const view=render(<Cash/>);fireEvent.click(screen.getByRole('button',{name:/Close register/}));
 const dialog=within(screen.getByRole('dialog'));
 dialog.getAllByRole('spinbutton').forEach((input,index)=>fireEvent.change(input,{target:{value:index===0?'1.001':'0.000'}}));
 fireEvent.click(dialog.getByRole('button',{name:'Close register'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 expect(dialog.getAllByRole('spinbutton').every(input=>input.hasAttribute('disabled'))).toBe(true);
 const original=mocks.rpc.mock.calls[0];view.unmount();mocks.session=null;render(<Cash/>);
 fireEvent.click(screen.getByRole('button',{name:/Retry saved session request/}));
 await waitFor(()=>expect(mocks.rpc).toHaveBeenCalledTimes(2));expect(mocks.rpc.mock.calls[1]).toEqual(original);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Acknowledge session receipt'})).toBeInTheDocument());
 expect(screen.getByRole('button',{name:/Open register now/})).toBeDisabled();
});
it('blocks corrupt persisted lifecycle data without sending a replacement request',async()=>{
 localStorage.setItem('zaipos:cash-session:v1:actor','{broken');render(<Cash/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('unreadable');
 expect(screen.getByRole('button',{name:/Open register now/})).toBeDisabled();expect(mocks.rpc).not.toHaveBeenCalled();
});
