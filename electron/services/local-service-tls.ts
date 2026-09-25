import tls from 'node:tls';
import { fingerprintsEqual, LocalServiceError, type ServerProfile } from './local-service-client.js';

export interface PinnedResponse {
  status: number;
  body: unknown;
}

export async function pinnedRequest(profile: ServerProfile, path: string, signal?: AbortSignal): Promise<PinnedResponse> {
  if (!path.startsWith('/v1/') || path.includes('..') || path.includes('?') || path.includes('#')) {
    throw new LocalServiceError('LOCAL_PROFILE_INVALID');
  }
  const socket = await openPinnedSocket(profile, signal);
  try {
    return await readHttp(socket, new URL(profile.origin).hostname, path);
  } finally {
    socket.end();
  }
}

export function openPinnedSocket(profile: ServerProfile, signal?: AbortSignal): Promise<tls.TLSSocket> {
  const url = new URL(profile.origin);
  const expectedHost = url.hostname;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, socket?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(socket!);
    };
    const socket = tls.connect({
      host: expectedHost,
      port: Number(url.port || 443),
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const rejectPinned = (error: Error) => {
      socket.destroy();
      finish(error);
    };
    const onAbort = () => rejectPinned(new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE'));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(5_000, () => rejectPinned(new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE')));
    socket.once('error', () => rejectPinned(new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE')));
    socket.once('secureConnect', () => {
      signal?.removeEventListener('abort', onAbort);
      const certificate = socket.getPeerCertificate(true);
      const fingerprint = rootFingerprint(certificate);
      const presentedHost = normalizeAddress(socket.remoteAddress);
      if (!fingerprint || !fingerprintsEqual(fingerprint, profile.caFingerprint) || presentedHost !== normalizeAddress(expectedHost)) {
        rejectPinned(new LocalServiceError('LOCAL_CA_MISMATCH'));
        return;
      }
      finish(undefined, socket);
    });
  });
}

function rootFingerprint(certificate: tls.DetailedPeerCertificate): string {
  if (!certificate || !certificate.fingerprint256) return '';
  let current = certificate;
  const seen = new Set<tls.DetailedPeerCertificate>();
  while (current.issuerCertificate && current.issuerCertificate !== current && !seen.has(current.issuerCertificate)) {
    seen.add(current);
    current = current.issuerCertificate;
  }
  return current.fingerprint256.replaceAll(':', '').toLowerCase();
}

function normalizeAddress(value: string | undefined): string {
  if (!value) return '';
  const lower = value.toLowerCase().replace(/^\[|\]$/g, '');
  return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
}

function readHttp(socket: tls.TLSSocket, host: string, path: string): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    let raw = '';
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return;
      const header = raw.slice(0, split);
      const body = raw.slice(split + 4);
      const [statusLine, ...lines] = header.split('\r\n');
      const status = Number(statusLine?.split(' ')[1]);
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        fail(new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE'));
        return;
      }
      if (lines.some((line) => line.toLowerCase().startsWith('location:'))) {
        fail(new LocalServiceError('LOCAL_ORIGIN_REJECTED'));
        return;
      }
      const lengthHeader = lines.find((line) => line.toLowerCase().startsWith('content-length:'));
      const length = Number(lengthHeader?.split(':')[1]?.trim());
      if (!Number.isInteger(length) || length < 0 || length > 1_048_576 || body.length < length) return;
      try {
        resolve({ status, body: JSON.parse(body.slice(0, length)) });
      } catch {
        fail(new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE'));
      }
    });
    socket.once('error', () => fail(new LocalServiceError('LOCAL_RUNTIME_UNAVAILABLE')));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`);
  });
}
