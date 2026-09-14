import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),error:vi.fn(),success:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:mocks.rpc}}));
vi.mock('sonner',()=>({toast:{error:mocks.error,success:mocks.success}}));
import {CashMovementDialog} from '../modules/cash/Cash';
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
it('recovers the original reference and exact payload after response loss and remount',async()=>{
 let total=0;const committed=new Set<string>();
 mocks.rpc.mockImplementation(async(method,args)=>{
  const reference=method==='record_cash_movement_v2'?args._reference:crypto.randomUUID();
  if(committed.has(reference))return {data:'original-movement',error:null};
  committed.add(reference);total+=1001;
  if(committed.size===1)throw new Error('Response lost after commit');
  return {data:'duplicate-movement',error:null};
 });
 render(<CashMovementDialog open type="in" sessionId="session" onClose={()=>undefined}/>);
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.change(screen.getByPlaceholderText('e.g. Extra float'),{target:{value:'Extra float receipt'}});
 fireEvent.change(screen.getByLabelText('Movement reference'),{target:{value:'FLOAT-20260914-001'}});
 fireEvent.click(screen.getByRole('button',{name:'Record'}));await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 cleanup();render(<CashMovementDialog open type="in" sessionId="session" onClose={()=>undefined}/>);
 expect(screen.getByLabelText('Movement reference')).toHaveValue('FLOAT-20260914-001');
 fireEvent.click(screen.getByRole('button',{name:'Record'}));await waitFor(()=>expect(mocks.success).toHaveBeenCalled());
 expect(total).toBe(1001);expect(mocks.rpc.mock.calls[1]).toEqual(mocks.rpc.mock.calls[0]);
});
it('does not send cash mutations when draft persistence fails',async()=>{
 render(<CashMovementDialog open type="in" sessionId="session" onClose={()=>undefined}/>);
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1.001'}});
 fireEvent.change(screen.getByPlaceholderText('e.g. Extra float'),{target:{value:'Verified float'}});
 fireEvent.change(screen.getByLabelText('Movement reference'),{target:{value:'FLOAT-20260914-002'}});
 const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage full');});
 fireEvent.click(screen.getByRole('button',{name:'Record'}));await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
 expect(mocks.rpc).not.toHaveBeenCalled();write.mockRestore();
});
