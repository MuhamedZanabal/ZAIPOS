import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({cashSession:vi.fn(),error:vi.fn(),getSession:vi.fn(),session:null as any}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:mocks.getSession}}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:vi.fn()}}));
vi.mock('@/hooks/useTenantContext',()=>({useTenantContext:()=>({tenantId:'10000000-0000-4000-8000-000000000001',branchId:'20000000-0000-4000-8000-000000000001',hasRole:()=>true})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({user:{id:'30000000-0000-4000-8000-000000000001'}})}));
vi.mock('@/hooks/useOpenSession',()=>({useOpenSession:()=>({data:mocks.session})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({data:[]}),useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/modules/cash/PendingTableOrders',()=>({PendingTableOrders:()=>null}));
import Cash from '@/modules/cash/Cash';
beforeEach(()=>{
 vi.clearAllMocks();localStorage.clear();mocks.session=null;
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async (_key:string,callback:()=>unknown)=>callback()}});
 mocks.getSession.mockResolvedValue({data:{session:{access_token:'operator-token'}},error:null});
 mocks.cashSession.mockResolvedValue('40000000-0000-4000-8000-000000000001');
 window.electron={cashSession:mocks.cashSession} as any;
});
it('rejects fractional-fils opening instead of rounding the typed float',async()=>{
 render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.0001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.cashSession).not.toHaveBeenCalled();
});
it('sends exact opening decimal text',async()=>{
 render(<Cash/>);fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.click(screen.getByRole('button',{name:/Open register now/}));
 await waitFor(()=>expect(mocks.cashSession).toHaveBeenCalled());
 expect(mocks.cashSession.mock.calls[0][0]).toMatchObject({_opening_amount:'1.001',_session_id:null});
 expect(mocks.cashSession.mock.calls[0][1]).toEqual({accessToken:'operator-token',tenantId:'10000000-0000-4000-8000-000000000001',branchId:'20000000-0000-4000-8000-000000000001'});
 expect(mocks.cashSession.mock.calls[0][2]).toBe(false);
});
it('requires all blind close counts explicitly, including zero buckets',async()=>{
 mocks.session={id:'40000000-0000-4000-8000-000000000001',opening_amount:1,total_cash:0,total_card:0,total_transfer:0,total_qr:0,total_in:0,total_out:0};
 render(<Cash/>);fireEvent.click(screen.getByRole('button',{name:/Close register/}));
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Close register'}));
 await waitFor(()=>expect(mocks.error).toHaveBeenCalled());expect(mocks.cashSession).not.toHaveBeenCalled();
});
it('sends each explicitly counted bucket as exact decimal text',async()=>{
 mocks.session={id:'40000000-0000-4000-8000-000000000001',opening_amount:1,total_cash:0,total_card:0,total_transfer:0,total_qr:0,total_in:0,total_out:0};
 render(<Cash/>);fireEvent.click(screen.getByRole('button',{name:/Close register/}));
 const dialog=within(screen.getByRole('dialog'));
 dialog.getAllByRole('spinbutton').forEach((input,index)=>fireEvent.change(input,{target:{value:index===0?'1.001':'0.000'}}));
 fireEvent.click(dialog.getByRole('button',{name:'Close register'}));
 await waitFor(()=>expect(mocks.cashSession).toHaveBeenCalled());
 expect(mocks.cashSession.mock.calls[0][0]).toMatchObject({_session_id:'40000000-0000-4000-8000-000000000001',_counted_amount:'1.001',_counted_card:'0.000',_counted_transfer:'0.000',_counted_qr:'0.000'});
 expect(mocks.cashSession.mock.calls[0][2]).toBe(true);
});
