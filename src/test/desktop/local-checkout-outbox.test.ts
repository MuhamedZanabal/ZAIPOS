import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalCheckoutOutbox, isLocalServerUnreachable } from '../../../electron/services/local-checkout-outbox';

const T = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const auth = { accessToken: 'session-token', tenantId: T, branchId: B } as any;
const sale = (id: string) => ({ _tenant_id: T, _branch_id: B, _client_mutation_id: id, _items: [{ product_id: 'p', quantity: 1 }], _device_credential: 'secret', _device_uid: 'uid' });
const ID1 = '33333333-3333-4333-8333-333333333333';
const ID2 = '44444444-4444-4444-8444-444444444444';
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-')), 'offline-sales.json');
const offline = () => Object.assign(new Error('LOCAL_RUNTIME_UNAVAILABLE'), { code: 'LOCAL_RUNTIME_UNAVAILABLE' });

describe('local checkout outbox', () => {
  it('classifies unreachable-server errors only', () => {
    expect(isLocalServerUnreachable(offline())).toBe(true);
    expect(isLocalServerUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:47321'))).toBe(true);
    expect(isLocalServerUnreachable(new Error('No register is open'))).toBe(false);
  });

  it('persists queued sales durably without secrets and survives a restart', () => {
    const file = tmpFile();
    const outbox = createLocalCheckoutOutbox(file, vi.fn());
    outbox.enqueue(sale(ID1));
    outbox.enqueue(sale(ID1)); // same sale retried while offline is not duplicated
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('session-token');
    expect(raw).not.toContain('_device_uid');
    const reopened = createLocalCheckoutOutbox(file, vi.fn());
    expect(reopened.status({ tenantId: T, branchId: B }).pending).toBe(1);
  });

  it('replays in order, removes committed sales, and stops while still offline', async () => {
    const file = tmpFile();
    const checkout = vi.fn()
      .mockResolvedValueOnce('sale-1')
      .mockRejectedValueOnce(offline());
    const outbox = createLocalCheckoutOutbox(file, checkout);
    outbox.enqueue(sale(ID1)); outbox.enqueue(sale(ID2));
    const summary = await outbox.replay(auth);
    expect(summary).toMatchObject({ attempted: 2, committed: 1, remaining: 1, saleIds: ['sale-1'] });
    expect(checkout.mock.calls[0][0]._client_mutation_id).toBe(ID1);
    expect(checkout.mock.calls[0][0]._device_credential).toBeUndefined();
    expect(createLocalCheckoutOutbox(file, vi.fn()).status().pending).toBe(1);
  });

  it('shares one in-flight replay so a sale is never sent twice concurrently', async () => {
    let release!: (v: string) => void;
    const checkout = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const outbox = createLocalCheckoutOutbox(tmpFile(), checkout);
    outbox.enqueue(sale(ID1));
    const a = outbox.replay(auth); const b = outbox.replay(auth);
    release('sale-1');
    await Promise.all([a, b]);
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it('keeps server-rejected sales for an operator decision', async () => {
    const checkout = vi.fn().mockRejectedValue(new Error('No register is open at this branch.'));
    const outbox = createLocalCheckoutOutbox(tmpFile(), checkout);
    outbox.enqueue(sale(ID1));
    await outbox.replay(auth);
    expect(outbox.status()).toMatchObject({ pending: 0, failed: 1 });
    outbox.resolveFailed(ID1, 'retry');
    expect(outbox.status().pending).toBe(1);
    await outbox.replay(auth);
    outbox.resolveFailed(ID1, 'discard');
    expect(outbox.status()).toMatchObject({ pending: 0, failed: 0 });
  });

  it('only replays sales for the authorised branch', async () => {
    const checkout = vi.fn().mockResolvedValue('x');
    const outbox = createLocalCheckoutOutbox(tmpFile(), checkout);
    outbox.enqueue(sale(ID1));
    await outbox.replay({ ...auth, branchId: '55555555-5555-4555-8555-555555555555' });
    expect(checkout).not.toHaveBeenCalled();
  });
});
