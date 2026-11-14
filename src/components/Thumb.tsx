import { useEffect, useRef, useState } from 'preact/hooks';
import { cachedUrl, imageUrl } from '../store';
import type { Photo } from '../lib/types';

let observer: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, () => void>();

function observe(el: Element, cb: () => void) {
  if (typeof IntersectionObserver === 'undefined') { cb(); return () => {}; }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        callbacks.get(e.target)?.();
        callbacks.delete(e.target);
        observer!.unobserve(e.target);
      }
    }
  }, { rootMargin: '600px 0px' });
  callbacks.set(el, cb);
  observer.observe(el);
  return () => { callbacks.delete(el); observer?.unobserve(el); };
}

export function Thumb({ photo, kind = 'thumb', alt = '' }: { photo: Photo; kind?: 'thumb' | 'full'; alt?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(() => cachedUrl(photo.id, kind));
  useEffect(() => {
    if (url || !ref.current) return;
    let live = true;
    const stop = observe(ref.current, () => {
      imageUrl(photo.id, kind).then((u) => live && setUrl(u));
    });
    return () => { live = false; stop(); };
  }, [photo.id, kind]);
  return (
    <div ref={ref} class={`thumb ${url ? 'loaded' : ''}`}>
      {url && <img src={url} alt={alt} draggable={false} />}
    </div>
  );
}
