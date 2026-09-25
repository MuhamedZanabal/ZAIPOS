import type { LocalSession, LocalUser } from './session';

type LocalError = { message: string } | null;
type LocalResult<T = unknown> = { data: T; error: LocalError };

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

async function localDispatch(path: string, payload: Record<string, unknown>): Promise<LocalResult> {
  const bridge = typeof window === 'undefined' ? undefined : window.electron?.localRequest;
  if (!bridge) return { data: null, error: { message: 'LOCAL_RUNTIME_NOT_CONFIGURED' } };
  try {
    const body = await bridge(path, payload);
    if (!body || typeof body !== 'object') return { data: null, error: { message: 'LOCAL_RUNTIME_UNAVAILABLE' } };
    const record = body as { data?: unknown; error?: string; access_token?: string; user?: LocalUser };
    if (typeof record.error === 'string') return { data: null, error: { message: record.error } };
    return { data: record.data ?? body, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : 'LOCAL_RUNTIME_UNAVAILABLE' } };
  }
}

function table(name: string): Record<string, unknown> {
  const steps: unknown[] = [];
  const exec = () => localDispatch('/v1/backend', { kind: 'table', table: name, steps });
  const builder: Record<string, unknown> = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return (resolve: (value: LocalResult) => unknown, reject: (reason: unknown) => unknown) => exec().then(resolve, reject);
      if (property === 'catch') return (reject: (reason: unknown) => unknown) => exec().catch(reject);
      return (...args: unknown[]) => {
        steps.push([String(property), args]);
        return builder;
      };
    },
  });
  return builder;
}

function storageBucket(bucket: string) {
  return {
    upload: (path: string, _file: unknown) => localDispatch('/v1/backend', { kind: 'attachment', action: 'put', bucket, path }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `app-attachment:${bucket}/${path}` } }),
  };
}

export function createLocalClient() {
  return {
    from: (name: string) => table(name),
    rpc: (fn: string, args?: Record<string, unknown>) => localDispatch('/v1/backend', { kind: 'rpc', fn, args: args ?? {} }),
    channel: (name: string) => {
      const handlers: Array<(payload: unknown) => void> = [];
      const channel = {
        on: (_event: string, _filter: unknown, callback: (payload: unknown) => void) => {
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
      invoke: (name: string, options?: { body?: unknown }) => localDispatch('/v1/backend', { kind: 'function', name, body: options?.body ?? null }),
    },
    auth: {
      getSession: async (): Promise<LocalResult<{ session: LocalSession | null }>> => ({ data: { session: readSession() }, error: null }),
      getUser: async (): Promise<LocalResult<{ user: LocalUser | null }>> => ({ data: { user: readSession()?.user ?? null }, error: null }),
      onAuthStateChange: (callback: (event: string, session: LocalSession | null) => void) => {
        listeners.add(callback);
        return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
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
    },
  };
}

export const localClient = createLocalClient();
