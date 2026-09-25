import { LocalServiceError } from './local-service-client.js';

export interface DiscoveryCandidate {
  origin: `https://${string}`;
  caFingerprint: string;
}

const FINGERPRINT = /^[a-f0-9]{64}$/;

export function parseDiscoveryInput(value: unknown): DiscoveryCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || keys.some((key) => key !== 'origin' && key !== 'caFingerprint')) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  const origin = requirePrivateHttpsOrigin(record.origin);
  const caFingerprint = requireFingerprint(record.caFingerprint);
  return { origin, caFingerprint };
}

export function requirePrivateHttpsOrigin(value: unknown): `https://${string}` {
  if (typeof value !== 'string' || value !== value.trim() || hasControlCharacter(value)) {
    throw new LocalServiceError('LOCAL_ORIGIN_REJECTED');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalServiceError('LOCAL_ORIGIN_REJECTED');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new LocalServiceError('LOCAL_ORIGIN_REJECTED');
  }
  if (!isLoopbackOrPrivate(url.hostname)) throw new LocalServiceError('LOCAL_ORIGIN_REJECTED');
  const port = url.port ? `:${url.port}` : '';
  return `https://${url.hostname}${port}`;
}

export function requireFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value.toLowerCase()) || value !== value.toLowerCase()) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isLoopbackOrPrivate(hostname: string): boolean {
  if (hostname.includes(':')) return isAllowedV6(hostname);
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isAllowedV6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1') return true;
  const first = normalized.split(':')[0] ?? '';
  if (!/^[0-9a-f]{0,4}$/.test(first)) return false;
  return first.startsWith('fc') || first.startsWith('fd') || first.startsWith('fe8') || first === 'fe80';
}
