import { timingSafeEqual } from 'node:crypto';
import { requireFingerprint, requirePrivateHttpsOrigin } from './local-service-discovery.js';

export type LocalServiceErrorCode =
  | 'LOCAL_CA_MISMATCH'
  | 'LOCAL_ORIGIN_REJECTED'
  | 'LOCAL_PROFILE_INVALID'
  | 'LOCAL_RUNTIME_NOT_CONFIGURED'
  | 'LOCAL_RUNTIME_UNAVAILABLE';

export class LocalServiceError extends Error {
  constructor(readonly code: LocalServiceErrorCode) {
    super(code);
    this.name = 'LocalServiceError';
  }
}

export interface ServerProfile {
  origin: `https://${string}`;
  caFingerprint: string;
  deviceCertificateRef: string;
}

export interface LocalHealth {
  status: 'starting' | 'ready' | 'migration_failed';
  database: 'unavailable' | 'ready';
}

export interface PinnedTls {
  observe(origin: string): Promise<{ fingerprint: string; hostname: string }>;
  request?(path: string, signal?: AbortSignal): Promise<unknown>;
}

const CERTIFICATE_REF = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseServerProfile(value: unknown): ServerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = ['origin', 'caFingerprint', 'deviceCertificateRef'];
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  if (typeof record.deviceCertificateRef !== 'string' || !CERTIFICATE_REF.test(record.deviceCertificateRef)) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  return {
    origin: requirePrivateHttpsOrigin(record.origin),
    caFingerprint: requireFingerprint(record.caFingerprint),
    deviceCertificateRef: record.deviceCertificateRef,
  };
}

export function fingerprintsEqual(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(byteString(left), byteString(right));
}

function byteString(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index);
  return bytes;
}

export function createLocalServiceClient(profile: ServerProfile, tls: PinnedTls) {
  const assertPinned = async () => {
    const observed = await tls.observe(profile.origin);
    const hostname = new URL(profile.origin).hostname;
    if (observed.hostname !== hostname || !fingerprintsEqual(observed.fingerprint, profile.caFingerprint)) {
      throw new LocalServiceError('LOCAL_CA_MISMATCH');
    }
  };
  return {
    async health(signal?: AbortSignal): Promise<LocalHealth> {
      if (signal?.aborted) throw new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE');
      await assertPinned();
      if (!tls.request) throw new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE');
      return parseHealth(await tls.request('/v1/health', signal));
    },
    async request<TResponse>(path: string, signal?: AbortSignal): Promise<TResponse> {
      if (!path.startsWith('/v1/') || path.includes('..')) throw new LocalServiceError('LOCAL_PROFILE_INVALID');
      await assertPinned();
      if (!tls.request) throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
      return (await tls.request(path, signal)) as TResponse;
    },
  };
}

export function localRuntimeStatus(): { state: 'not_configured' } {
  return { state: 'not_configured' };
}

export function rejectUnprovisionedLocalCall(): never {
  throw new LocalServiceError('LOCAL_RUNTIME_NOT_CONFIGURED');
}

function parseHealth(value: unknown): LocalHealth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'status' && key !== 'database')) {
    throw new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE');
  }
  if (
    (record.status !== 'starting' && record.status !== 'ready' && record.status !== 'migration_failed')
    || (record.database !== 'unavailable' && record.database !== 'ready')
  ) {
    throw new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE');
  }
  return { status: record.status, database: record.database };
}
