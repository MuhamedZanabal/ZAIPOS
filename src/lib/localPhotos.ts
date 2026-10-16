import { localDispatch } from '@/backend/local-client';

export const ATTACHMENT_SCHEME = 'app-attachment:';
const MAX_EDGE = 1024;
const TARGET_BYTES = 600 * 1024;

/** Reads a file as base64 (no data: prefix). */
async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Downsizes large photos to ≤1024 px JPEG so uploads stay under the server's 700 KB limit. */
export async function prepareProductPhoto(file: Blob): Promise<Blob> {
  if (file.size <= TARGET_BYTES || typeof createImageBitmap !== 'function') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= TARGET_BYTES) return blob;
  }
  throw new Error('Photo is too large even after resizing');
}

export async function uploadLocalPhoto(bucket: string, tenantId: string, file: Blob): Promise<{ path: string }> {
  const prepared = await prepareProductPhoto(file);
  const result = await localDispatch('/v1/storage/upload', { bucket, tenant_id: tenantId, data_base64: await toBase64(prepared) });
  if (result.error) throw new Error(result.error.message);
  const path = (result.data as { path?: unknown } | null)?.path;
  if (typeof path !== 'string') throw new Error('Photo could not be saved');
  return { path };
}

const cache = new Map<string, Promise<string | null>>();

/** Resolves an app-attachment:<bucket>/<tenant>/<hash> reference to a data: URL (cached). Other URLs pass through. */
export function resolvePhotoUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  if (!url.startsWith(ATTACHMENT_SCHEME)) return Promise.resolve(url);
  const hit = cache.get(url);
  if (hit) return hit;
  const [bucket, tenant, hash] = url.slice(ATTACHMENT_SCHEME.length).split('/');
  const pending = localDispatch('/v1/storage/download', { bucket, tenant_id: tenant, hash }).then((result) => {
    const data = result.data as { content_type?: string; data_base64?: string } | null;
    if (result.error || !data?.data_base64 || !/^image\/(jpeg|png|webp)$/.test(data.content_type ?? '')) { cache.delete(url); return null; }
    return `data:${data.content_type};base64,${data.data_base64}`;
  });
  cache.set(url, pending);
  return pending;
}
