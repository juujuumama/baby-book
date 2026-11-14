import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

/** A soft bottom sheet on phones, a centered card on bigger screens. */
export function Sheet({ title, onClose, children, wide }: { title?: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.classList.add('no-scroll');
    return () => { window.removeEventListener('keydown', k); document.body.classList.remove('no-scroll'); };
  }, [onClose]);
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-grip" />
        {title && (
          <div class="sheet-head">
            <h2>{title}</h2>
            <button class="icon-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        )}
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}
