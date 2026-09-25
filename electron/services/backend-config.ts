import type { BackendConfig } from '../types.js';

const normalizeUrl = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Supabase URL is required');
  const candidate = value.trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error('Supabase URL is invalid'); }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Supabase URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Supabase URL must not contain credentials or parameters');
  return url.toString().replace(/\/$/, '');
};

export const validateBackendConfig = (input: unknown): BackendConfig => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Backend configuration is invalid');
  const record = input as Record<string, unknown>;
  const supabaseUrl = normalizeUrl(record.supabaseUrl);
  const supabasePublishableKey = typeof record.supabasePublishableKey === 'string'
    ? record.supabasePublishableKey.trim()
    : '';
  if (!supabasePublishableKey || supabasePublishableKey.length > 4096) throw new Error('Supabase publishable key is invalid');
  if (/service[_-]?role/i.test(supabasePublishableKey)) throw new Error('Service-role credentials are forbidden');
  return { supabaseUrl, supabasePublishableKey };
};

export const verifyBackendConnection = async (config: BackendConfig): Promise<void> => {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/settings`, {
    headers: { apikey: config.supabasePublishableKey },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Supabase rejected the connection (${response.status})`);
};
