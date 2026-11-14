import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fullLabel, type PrintInfo } from '../lib/printLabels';
import type { Photo } from '../lib/types';
import type { Quad } from '../lib/vision/warp';
import { Thumb } from './Thumb';

export interface WalkStep {
  quad: Quad;
  print: string;
  /** 1-based position in date order, or null for prints that couldn't be matched. */
  n: number | null;
  photoId: string | null;
  index: number; // index into the found list (for "change match")
}

/**
 * Go through the prints one at a time, in order, so the physical prints can be
 * picked up off the floor and stacked. Each step shows where the print lies in
 * the photo, a close-up, and its label.
 */
export function OrderWalk({ base, steps, positions, byId, total, onClose, onFix }: {
  base: HTMLCanvasElement; steps: WalkStep[]; positions: Map<string, PrintInfo>; byId: Map<string, Photo>;
  total: number; onClose: () => void; onFix: (index: number) => void;
}) {
  const [k, setK] = useState(0);
  const overview = useRef<HTMLCanvasElement>(null);
  const closeup = useRef<HTMLCanvasElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const step = steps[Math.min(k, steps.length - 1)];

  // A smaller copy of the photo for the overview; drawing the full one each step is slow on phones.
  const small = useMemo(() => {
    const s = Math.min(1, 1400 / Math.max(base.width, base.height));
    const c = document.createElement('canvas');
    c.width = Math.round(base.width * s);
    c.height = Math.round(base.height * s);
    c.getContext('2d')!.drawImage(base, 0, 0, c.width, c.height);
    return { c, s };
  }, [base]);

  useEffect(() => {
    if (!step) return;
    drawOverview();
    drawCloseup();
  }, [k, step]);

  function path(ctx: CanvasRenderingContext2D, q: Quad, s: number, ox = 0, oy = 0) {
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo((p.x - ox) * s, (p.y - oy) * s) : ctx.moveTo((p.x - ox) * s, (p.y - oy) * s)));
    ctx.closePath();
  }

  function drawOverview() {
    const c = overview.current;
    if (!c) return;
    const { c: img, s } = small;
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = 'rgba(20, 24, 34, 0.62)';
    ctx.fillRect(0, 0, c.width, c.height);
    // Already-handled prints get a small tick so the floor is easy to read.
    const u = Math.max(c.width, c.height) / 600;
    steps.slice(0, k).forEach((st) => {
      ctx.save();
      path(ctx, st.quad, s);
      ctx.clip();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    });
    ctx.save();
    path(ctx, step.quad, s);
    ctx.clip();
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    path(ctx, step.quad, s);
    ctx.lineWidth = 4 * u;
    ctx.strokeStyle = step.n ? '#ffd76a' : '#ff9d5c';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawCloseup() {
    const c = closeup.current;
    if (!c) return;
    const xs = step.quad.map((p) => p.x), ys = step.quad.map((p) => p.y);
    const qw = Math.max(...xs) - Math.min(...xs), qh = Math.max(...ys) - Math.min(...ys);
    const pad = Math.max(qw, qh) * 0.35;
    const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
    const x1 = Math.min(base.width, Math.max(...xs) + pad), y1 = Math.min(base.height, Math.max(...ys) + pad);
    const s = Math.min(1.5, 700 / Math.max(x1 - x0, y1 - y0));
    c.width = Math.round((x1 - x0) * s);
    c.height = Math.round((y1 - y0) * s);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(base, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
    path(ctx, step.quad, s, x0, y0);
    ctx.lineWidth = 4;
    ctx.strokeStyle = step.n ? '#ffd76a' : '#ff9d5c';
    ctx.stroke();
  }

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

  if (!step) return null;
  const info = step.photoId ? positions.get(step.photoId) : null;
  const photo = step.photoId ? byId.get(step.photoId) : null;
  const last = k === steps.length - 1;

  return (
    <div class="walk" role="dialog" aria-modal="true"
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

      <canvas ref={overview} class="walk-overview" />

      <div class="walk-card">
        <div class="walk-head">
          <span class={`walk-num ${step.n ? '' : 'warn'}`}>{step.n ?? '?'}</span>
          <div class="walk-label">
            {step.n ? (
              <>
                <div class="walk-title">{info ? fullLabel(info).split(' · #')[0] : 'No date yet'}</div>
                <div class="walk-sub">{step.n === 1 ? 'First' : `Number ${step.n}`} of {total} in this batch{info ? ` · #${info.index} of ${info.total} that month` : ''}</div>
              </>
            ) : (
              <>
                <div class="walk-title">Not matched</div>
                <div class="walk-sub">Set this one aside, or tap "Pick photo"</div>
              </>
            )}
          </div>
        </div>
        <div class="walk-images">
          <canvas ref={closeup} class="walk-closeup" />
          {photo && <div class="walk-match"><Thumb photo={photo} /><span>your photo</span></div>}
        </div>
      </div>

      <div class="walk-nav">
        <button class="btn light" disabled={k === 0} onClick={() => go(-1)}>‹ Back</button>
        <button class="btn light ghost small" onClick={() => onFix(step.index)}>{step.n ? 'Wrong photo?' : 'Pick photo'}</button>
        {last ? <button class="btn primary-light" onClick={onClose}>Done ✓</button>
          : <button class="btn primary-light" onClick={() => go(1)}>Next ›</button>}
      </div>
    </div>
  );
}
