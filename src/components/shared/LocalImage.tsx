import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { resolvePhotoUrl } from '@/lib/localPhotos';

/** <img> that also understands photos stored on the ZAIPOS server (app-attachment: references). */
export function LocalImage({ src, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string | null | undefined }) {
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void resolvePhotoUrl(src).then((url) => { if (alive) setResolved(url); });
    return () => { alive = false; };
  }, [src]);
  return resolved ? <img src={resolved} {...rest} /> : null;
}
