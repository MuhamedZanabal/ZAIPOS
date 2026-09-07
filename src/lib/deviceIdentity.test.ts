import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeviceId } from './deviceIdentity';

describe('device identity', () => {
  beforeEach(() => window.localStorage.clear());

  it('preserves an installed terminal legacy identity', () => {
    window.localStorage.setItem('poss360t_device_id', 'legacy-terminal-id');
    expect(getDeviceId()).toBe('legacy-terminal-id');
    expect(window.localStorage.getItem('zaipos_device_id')).toBe('legacy-terminal-id');
  });

  it('creates one stable ZAIPOS identity', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(getDeviceId()).toBe('00000000-0000-4000-8000-000000000001');
    expect(getDeviceId()).toBe('00000000-0000-4000-8000-000000000001');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});
