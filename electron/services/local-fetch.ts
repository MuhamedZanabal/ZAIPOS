import { pinnedRequest } from './local-service-tls.js';
import type { ServerProfile } from './local-service-client.js';

/**
 * Device, offline-lease and manager-authorization calls in Electron main use
 * `fetch`. Against the local service that fails, because its certificate is
 * self-issued and trusted only by fingerprint. This sends requests for the
 * pinned local origin through the fingerprint-checked TLS client and leaves
 * every other origin to the normal fetch.
 */
export function createLocalAwareFetch(
  getProfile: () => ServerProfile | null,
  base: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const profile = getProfile();
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!profile || target.origin !== new URL(profile.origin).origin) return base(input, init);
    const headers = new Headers(init?.headers);
    const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '') || undefined;
    const raw = init?.body;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new TypeError('Local service requests must have a JSON body');
    const body = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : undefined;
    const response = await pinnedRequest(profile, target.pathname, init?.signal ?? undefined, body, bearer);
    return new Response(JSON.stringify(response.body ?? null), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
