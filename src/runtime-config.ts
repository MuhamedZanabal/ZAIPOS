export type RuntimeConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
};

export type RuntimeConfigResult =
  | { ok: true; config: RuntimeConfig }
  | { ok: false; missing: Array<keyof RuntimeConfig> };

const isAllowedSupabaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ||
      ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:');
  } catch {
    return false;
  }
};

export const readRuntimeConfig = (
  env: Record<string, string | boolean | undefined> = import.meta.env,
): RuntimeConfigResult => {
  const supabaseUrl = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const supabasePublishableKey = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === 'string'
    ? env.VITE_SUPABASE_PUBLISHABLE_KEY.trim()
    : '';
  const missing: Array<keyof RuntimeConfig> = [];

  if (!supabaseUrl || !isAllowedSupabaseUrl(supabaseUrl)) missing.push('supabaseUrl');
  if (!supabasePublishableKey) missing.push('supabasePublishableKey');

  return missing.length
    ? { ok: false, missing }
    : { ok: true, config: { supabaseUrl, supabasePublishableKey } };
};

let activeConfig: RuntimeConfig | null = null;

export const initializeRuntimeConfig = async (): Promise<RuntimeConfigResult> => {
  const bundled = readRuntimeConfig();
  if (bundled.ok) {
    activeConfig = bundled.config;
    return bundled;
  }
  const stored = await window.electron?.getBackendConfig?.();
  const resolved = readRuntimeConfig(stored ? {
    VITE_SUPABASE_URL: stored.supabaseUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: stored.supabasePublishableKey,
  } : {});
  if (resolved.ok) activeConfig = resolved.config;
  return resolved;
};

export const getRuntimeConfig = (): RuntimeConfig => {
  if (!activeConfig) throw new Error('ZAIPOS runtime configuration was not initialized');
  return activeConfig;
};
