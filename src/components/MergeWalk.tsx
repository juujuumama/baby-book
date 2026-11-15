import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fullLabel, type PrintInfo } from '../lib/printLabels';
import { mergeOrder, type Pile } from '../lib/sortSession';
import type { Photo } from '../lib/types';
import { Thumb } from './Thumb';

/** Combine sorted piles into one stack: "take the top print from pile B". */
export function MergeWalk({ piles, positions, byId, onClose }: {
  piles: Pile[]; positions: Map<string, PrintInfo>; byId: Map<string, Photo>; onClose: () => void;
}) {
  const steps = useMemo(() => mergeOrder(piles, (id) => byId.get(id)?.taken ?? '￿'), [piles, byId]);
  const [k, setK] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = (d: number) => setK((v) => Math.min(steps.length - 1, Math.max(0, v + d)));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    document.body.classList.add('no-scroll');
    return () => { window.removeEventListener('keydown', key); document.body.classList.remove('no-scroll'); };
  }, [steps.length]);

  if (!steps.length) return null;
  const step = steps[k];
  const photo = byId.get(step.photoId);
  const info = positions.get(step.photoId);
  // How many are left in each pile, to help keep track.
  const left = piles.map((p) => ({ label: p.label, n: p.photoIds.length - steps.slice(0, k).filter((s) => s.pile === p.label).length }));
  const last = k === steps.length - 1;

  return (
    <div class="walk merge" role="dialog" aria-modal="true"
      onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
      onTouchEnd={(e) => {
        const s0 = touch.current; touch.current = null;
        if (!s0) return;
        const t = e.changedTouches[0], dx = t.clientX - s0.x, dy = t.clientY - s0.y;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1);
      }}>
      <div class="walk-top">
        <button class="icon-btn light" onClick={onClose} aria-label="Close">✕</button>
        <div class="walk-progress"><div class="walk-progress-fill" style={{ width: `${((k + 1) / steps.length) * 100}%` }} /></div>
        <span class="walk-count">{k + 1} / {steps.length}</span>
      </div>

      <div class="merge-instruction">
        <span class="merge-from">Take the top print from</span>
        <span class="merge-pile">pile {step.pile}</span>
      </div>

      <div class="walk-card">
        <div class="walk-head">
          <span class="walk-num">{step.n}</span>
          <div class="walk-label">
            <div class="walk-title">{info ? fullLabel(info).split(' · #')[0] : 'No date yet'}</div>
            <div class="walk-sub">{step.n} of {steps.length} overall{info ? ` · #${info.index} of ${info.total} that month` : ''}</div>
          </div>
        </div>
        {photo && <div class="merge-photo"><Thumb photo={photo} kind="full" /></div>}
        {last && <p class="walk-sub strong">That's the last one. Flip your new stack over and it runs from oldest to newest.</p>}
        <div class="merge-left">{left.map((l) => <span key={l.label} class={l.label === step.pile ? 'on' : ''}>Pile {l.label}: {l.n} left</span>)}</div>
      </div>

      <div class="walk-nav">
        <button class="btn light" disabled={k === 0} onClick={() => go(-1)}>‹ Back</button>
        {last ? <button class="btn primary-light" onClick={onClose}>All in order ✓</button>
          : <button class="btn primary-light" onClick={() => go(1)}>Next ›</button>}
      </div>
    </div>
  );
}
