import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatch = vi.fn();
vi.mock('@/backend/local-client', () => ({ localDispatch: (...args: unknown[]) => dispatch(...args) }));
import { resolvePhotoUrl, uploadLocalPhoto } from './localPhotos';

describe('local product photos', () => {
  beforeEach(() => dispatch.mockReset());

  it('uploads base64 bytes for the tenant and returns the server path', async () => {
    dispatch.mockResolvedValue({ data: { path: 't1/abc' }, error: null });
    const file = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
    await expect(uploadLocalPhoto('product-images', 't1', file)).resolves.toEqual({ path: 't1/abc' });
    expect(dispatch).toHaveBeenCalledWith('/v1/storage/upload', { bucket: 'product-images', tenant_id: 't1', data_base64: '/9j/4A==' });
  });

  it('surfaces server rejections', async () => {
    dispatch.mockResolvedValue({ data: null, error: { message: 'Only JPEG, PNG or WebP photos are allowed' } });
    await expect(uploadLocalPhoto('product-images', 't1', new Blob(['x']))).rejects.toThrow('Only JPEG');
  });

  it('resolves app-attachment references to image data URLs and refuses other types', async () => {
    dispatch.mockResolvedValueOnce({ data: { content_type: 'image/png', data_base64: 'AAA=' }, error: null });
    await expect(resolvePhotoUrl('app-attachment:product-images/t1/h1')).resolves.toBe('data:image/png;base64,AAA=');
    expect(dispatch).toHaveBeenCalledWith('/v1/storage/download', { bucket: 'product-images', tenant_id: 't1', hash: 'h1' });
    dispatch.mockResolvedValueOnce({ data: { content_type: 'text/html', data_base64: 'PHNjcmlwdD4=' }, error: null });
    await expect(resolvePhotoUrl('app-attachment:product-images/t1/h2')).resolves.toBeNull();
    await expect(resolvePhotoUrl('https://example.test/a.png')).resolves.toBe('https://example.test/a.png');
    await expect(resolvePhotoUrl(null)).resolves.toBeNull();
  });
});
