import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBackendConfig, verifyBackendConnection } from '../../../electron/services/backend-config';

describe('native backend configuration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes a secure public project configuration', () => {
    expect(validateBackendConfig({
      supabaseUrl: ' https://project.supabase.co/ ',
      supabasePublishableKey: ' publishable-key ',
    })).toEqual({ supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'publishable-key' });
  });

  it('rejects remote HTTP, credentials in URLs, and service-role labels', () => {
    expect(() => validateBackendConfig({ supabaseUrl: 'http://project.supabase.co', supabasePublishableKey: 'key' })).toThrow('HTTPS');
    expect(() => validateBackendConfig({ supabaseUrl: 'https://user:pass@project.supabase.co', supabasePublishableKey: 'key' })).toThrow('credentials');
    expect(() => validateBackendConfig({ supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'service_role-key' })).toThrow('forbidden');
  });

  it('verifies the Auth endpoint and fails closed on rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyBackendConnection({ supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'public-key' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://project.supabase.co/auth/v1/settings', expect.objectContaining({ headers: { apikey: 'public-key' } }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(verifyBackendConnection({ supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'bad-key' })).rejects.toThrow('(401)');
  });
});
