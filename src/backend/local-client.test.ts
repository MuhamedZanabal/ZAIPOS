import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => { delete (window as { electron?: unknown }).electron; });

  it('keeps the server error code so callers can branch on it (e.g. ZS001 cash-session conflicts)', async () => {
    (window as { electron?: unknown }).electron = { localRequest: vi.fn().mockResolvedValue({ error: 'different actor', code: 'ZS001' }) };
    const client = createLocalClient();
    const result = await client.rpc('apply_cash_session_v2', {});
    expect(result.error?.code).toBe('ZS001');
    expect(result.data).toBeNull();
  });

  it('sends every chained query step and resolves typed results', async () => {
    const localRequest = vi.fn().mockResolvedValue({ data: [{ id: 'p1' }] });
    (window as { electron?: unknown }).electron = { localRequest };
    const { data, error } = await createLocalClient().from('products').select('id').eq('tenant_id', 't1').order('name');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 'p1' }]);
    expect(localRequest.mock.calls[0][1]).toMatchObject({ kind: 'table', table: 'products', steps: [['select', ['id']], ['eq', ['tenant_id', 't1']], ['order', ['name']]] });
  });

  it('auth listener unsubscribe stops further notifications', async () => {
    const client = createLocalClient();
    const seen: string[] = [];
    const { data } = client.auth.onAuthStateChange((event) => seen.push(event));
    data.subscription.unsubscribe();
    await client.auth.signOut();
    expect(seen).toEqual([]);
  });
});
