import { createHash, generateKeyPairSync, sign as signBuffer, type KeyObject } from 'node:crypto';
import { LocalServiceError, parseServerProfile, type ServerProfile } from './local-service-client.js';
import { parseDiscoveryInput } from './local-service-discovery.js';
import { pinnedRequest } from './local-service-tls.js';

export interface LocalProfileStore {
  read(): ServerProfile | null;
  write(profile: ServerProfile): void;
}

export interface LocalTransport {
  request(profile: ServerProfile, path: string, signal?: AbortSignal, body?: unknown, authorization?: string): Promise<{ status: number; body: unknown }>;
}

export interface LocalRuntimeStatus {
  state: 'not_configured' | 'configured';
  origin?: string;
  caFingerprint?: string;
  deviceCertificateRef?: string | null;
}

export function createLocalRuntime(store: LocalProfileStore, transport: LocalTransport = { request: pinnedRequest }) {
  let privateKey: KeyObject | null = null;
  let certificateRef: string | null = null;
  return {
    status(): LocalRuntimeStatus {
      const profile = store.read();
      if (!profile) return { state: 'not_configured' };
      return {
        state: 'configured',
        origin: profile.origin,
        caFingerprint: profile.caFingerprint,
        deviceCertificateRef: profile.deviceCertificateRef === 'unenrolled' ? certificateRef : profile.deviceCertificateRef,
      };
    },
    async connect(candidate: unknown, signal?: AbortSignal): Promise<LocalRuntimeStatus> {
      const discovery = parseDiscoveryInput(candidate);
      const profile = parseServerProfile({ ...discovery, deviceCertificateRef: 'unenrolled' });
      const health = await transport.request(profile, '/v1/health', signal);
      if (!isHealth(health.body)) throw new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE');
      store.write(profile);
      return this.status();
    },
    async request(path: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
      const profile = store.read();
      if (!profile) throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
      const openBeforeEnrollment = path === '/v1/health' || path.startsWith('/v1/auth/');
      if (profile.deviceCertificateRef === 'unenrolled' && !openBeforeEnrollment) {
        throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
      }
      const { payload, authorization } = unwrapSession(body);
      const response = await transport.request(profile, path, signal, payload, authorization);
      return response.body;
    },
    enroll(): { certificateRef: string } {
      if (!store.read()) throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
      const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      privateKey = generated.privateKey;
      const publicPem = generated.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      certificateRef = createHash('sha256').update(publicPem).digest('hex').slice(0, 32);
      return { certificateRef };
    },
    signChallenge(challenge: Uint8Array): Buffer {
      if (!privateKey) throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
      return signBuffer('sha256', challenge, privateKey);
    },
    subscribe(): never {
      throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
    },
  };
}

export function adoptInstalledProfile(stored: unknown, installed: unknown): { profile: ServerProfile | null; persist: boolean } {
  if (stored) {
    try {
      return { profile: parseServerProfile(stored), persist: false };
    } catch {
      return { profile: null, persist: false };
    }
  }
  if (!installed) return { profile: null, persist: false };
  try {
    return { profile: parseServerProfile(installed), persist: true };
  } catch {
    return { profile: null, persist: false };
  }
}

function unwrapSession(body: unknown): { payload: unknown; authorization?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { payload: body };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.zaiposSession !== 'string' || !('zaiposPayload' in record)) {
    return { payload: body };
  }
  if (record.zaiposSession.length < 32 || record.zaiposSession.length > 4096 || /[^\x21-\x7e]/.test(record.zaiposSession)) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  return { payload: record.zaiposPayload, authorization: record.zaiposSession };
}

function isHealth(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => key === 'status' || key === 'database')
    && (record.status === 'starting' || record.status === 'ready' || record.status === 'migration_failed')
    && (record.database === 'unavailable' || record.database === 'ready');
}
