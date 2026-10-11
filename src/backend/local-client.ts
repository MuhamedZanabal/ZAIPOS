import type { LocalSession, LocalUser } from './session';
import { englishServerMessage } from '@/lib/serverMessages';

type LocalError = { message: string; code?: string } | null;
type LocalResult<T = unknown> = { data: T; error: LocalError; count?: number | null };

const SESSION_KEY = 'zaipos.local.session';
const listeners = new Set<(event: string, session: LocalSession | null) => void>();

function readSession(): LocalSession | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LocalSession;
    if (!parsed?.user?.id || !parsed.access_token || raw.includes('"password"')) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return { access_token: parsed.access_token, user: parsed.user, expires_at: parsed.expires_at };
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function writeSession(session: LocalSession | null): void {
  if (typeof localStorage === 'undefined') return;
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  for (const listener of listeners) listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
}

export async function localDispatch(path: string, payload: Record<string, unknown>): Promise<LocalResult> {
  const bridge = typeof window === 'undefined' ? undefined : window.electron?.localRequest;
  if (!bridge) return { data: null, error: { message: 'LOCAL_RUNTIME_NOT_CONFIGURED' } };
  const token = readSession()?.access_token;
  const transmitted = token ? { zaiposSession: token, zaiposPayload: payload } : payload;
  try {
    const body = await bridge(path, transmitted);
    if (!body || typeof body !== 'object') return { data: null, error: { message: 'LOCAL_RUNTIME_UNAVAILABLE' } };
    const record = body as { data?: unknown; error?: string; code?: unknown; count?: unknown; access_token?: string; user?: LocalUser };
    if (typeof record.error === 'string') {
      const message = englishServerMessage(record.error);
      return { data: null, error: typeof record.code === 'string' ? { message, code: record.code } : { message } };
    }
    if ('count' in record) return { data: record.data ?? null, error: null, count: typeof record.count === 'number' ? record.count : null };
    return { data: 'data' in record ? record.data ?? null : body, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : 'LOCAL_RUNTIME_UNAVAILABLE' } };
  }
}

/**
 * Chainable query builder mirroring the supabase-js surface the UI uses
 * (select/eq/order/single/...). Every chain step is recorded and sent to the
 * local service when the builder is awaited.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = LocalResult<any>;
export interface LocalQuery extends PromiseLike<AnyResult> {
  catch(reject: (reason: unknown) => unknown): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: (...args: any[]) => any;
}

function table(name: string): LocalQuery {
  const steps: unknown[] = [];
  const exec = () => localDispatch('/v1/backend', { kind: 'table', table: name, steps });
  const builder = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return (resolve: (value: LocalResult) => unknown, reject: (reason: unknown) => unknown) => exec().then(resolve, reject);
      if (property === 'catch') return (reject: (reason: unknown) => unknown) => exec().catch(reject);
      return (...args: unknown[]) => {
        steps.push([String(property), args]);
        return builder;
      };
    },
  }) as LocalQuery;
  return builder;
}

function storageBucket(bucket: string) {
  return {
    // The local service does not store file bytes yet; fail clearly instead of
    // recording a path that points at nothing.
    upload: async (_path: string, _file: unknown, _options?: { upsert?: boolean; contentType?: string }): Promise<AnyResult> =>
      ({ data: null, error: { message: `Photo uploads (${bucket}) are not available on this ZAIPOS server yet. Save without a photo.` } }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `app-attachment:${bucket}/${path}` } }),
  };
}

export function createLocalClient() {
  return {
    from: (name: string) => table(name),
    rpc: (fn: string, args?: Record<string, unknown>): Promise<AnyResult> => localDispatch('/v1/backend', { kind: 'rpc', fn, args: args ?? {} }),
    channel: (name: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handlers: Array<(payload: { new?: any; old?: any; eventType?: string }) => void> = [];
      const channel = {
        // Realtime is not wired in the local runtime yet; handlers are kept but never fire.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        on: (_event: string, _filter: unknown, callback: (payload: { new?: any; old?: any; eventType?: string }) => void) => {
          handlers.push(callback);
          return channel;
        },
        subscribe: () => channel,
        topic: name,
      };
      return channel;
    },
    removeChannel: (_channel: unknown) => Promise.resolve('ok'),
    storage: { from: (bucket: string) => storageBucket(bucket) },
    functions: {
      invoke: (name: string, options?: { body?: unknown }): Promise<AnyResult> => localDispatch('/v1/backend', { kind: 'function', name, body: options?.body ?? null }),
    },
    auth: {
      getSession: async (): Promise<LocalResult<{ session: LocalSession | null }>> => ({ data: { session: readSession() }, error: null }),
      getUser: async (): Promise<LocalResult<{ user: LocalUser | null }>> => ({ data: { user: readSession()?.user ?? null }, error: null }),
      onAuthStateChange: (callback: (event: string, session: LocalSession | null) => void) => {
        listeners.add(callback);
        return { data: { subscription: { unsubscribe: (): void => { listeners.delete(callback); } } } };
      },
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        const result = await localDispatch('/v1/auth/login', { kind: 'auth', action: 'login', email, password });
        const session = (result.data as { session?: LocalSession } | null)?.session;
        if (result.error || !session?.access_token || session.access_token === password) {
          return { data: { user: null, session: null }, error: result.error ?? { message: 'LOCAL_RUNTIME_NOT_CONFIGURED' } };
        }
        writeSession(session);
        return { data: { user: session.user, session }, error: null };
      },
      signOut: async () => {
        await localDispatch('/v1/auth/logout', { kind: 'auth', action: 'logout' });
        writeSession(null);
        return { error: null };
      },
      bootstrapOwner: async ({ email, password, tenantName, branchName, businessMode = 'RETAIL' }: { email: string; password: string; tenantName: string; branchName: string; businessMode?: string }) => {
        const result = await localDispatch('/v1/auth/bootstrap', { kind: 'auth', action: 'bootstrap', email, password, tenant_name: tenantName, branch_name: branchName, business_mode: businessMode });
        const session = (result.data as { session?: LocalSession } | null)?.session;
        if (result.error || !session?.access_token || session.access_token === password) {
          return { data: { user: null, session: null }, error: result.error ?? { message: 'LOCAL_RUNTIME_NOT_CONFIGURED' } };
        }
        writeSession(session);
        return { data: { user: session.user, session }, error: null };
      },
    },
  };
}

export const localClient = createLocalClient();
