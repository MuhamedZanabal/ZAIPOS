import { describe, expect, it } from 'vitest';
import { readRuntimeConfig } from '../runtime-config';

describe('desktop runtime configuration', () => {
  it('accepts a secure Supabase URL and publishable key', () => {
    expect(readRuntimeConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    })).toEqual({
      ok: true,
      config: {
        supabaseUrl: 'https://project.supabase.co',
        supabasePublishableKey: 'publishable-key',
      },
    });
  });

  it('fails closed when either required value is absent', () => {
    expect(readRuntimeConfig({})).toEqual({
      ok: false,
      missing: ['supabaseUrl', 'supabasePublishableKey'],
    });
    expect(readRuntimeConfig({ VITE_SUPABASE_URL: 'https://project.supabase.co' })).toEqual({
      ok: false,
      missing: ['supabasePublishableKey'],
    });
  });

  it('rejects insecure remote and malformed URLs', () => {
    for (const value of ['http://project.supabase.co', 'not-a-url']) {
      expect(readRuntimeConfig({
        VITE_SUPABASE_URL: value,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
      })).toEqual({ ok: false, missing: ['supabaseUrl'] });
    }
  });

  it('allows loopback HTTP for local development only', () => {
    expect(readRuntimeConfig({
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'local-anon-key',
    }).ok).toBe(true);
  });
});
