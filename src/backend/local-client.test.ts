import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalClient } from './local-client';

describe('local backend client', () => {
  beforeEach(() => localStorage.clear());

  it('does not sign in or store a password when the local runtime is absent', async () => {
    const client = createLocalClient();
    const result = await client.auth.signInWithPassword({ email: 'owner@shop.test', password: 'hunter2' });
    expect(result.error?.message).toBe('LOCAL_RUNTIME_NOT_CONFIGURED');
    expect(localStorage.getItem('zaipos.local.session')).toBeNull();
    const query = client['from']('sales');
    const table = await query['select']('total')['eq']('branch_id', 'branch-1');
    expect(table.error?.message).toBe('LOCAL_RUNTIME_NOT_CONFIGURED');
  });
});
