import { useEffect, useRef, useState } from 'preact/hooks';
import { ageInMonths, ageShort, formatLong, formatTime, parseYMD, type YMD } from '../lib/dates';
import { holidayOn } from '../lib/holidays';
import type { Photo } from '../lib/types';
import { imageUrl, patchPhoto, removePhotos } from '../store';
import { DateEditor } from './DateEditor';
import { Sheet } from './Sheet';

export function PhotoViewer({ photos, startId, birth, onClose }: { photos: Photo[]; startId: string; birth: YMD | null; onClose: () => void }) {
  const [id, setId] = useState(startId);
  const [url, setUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);

  let index = photos.findIndex((p) => p.id === id);
  if (index < 0) index = Math.min(photos.length - 1, 0);
  const photo = photos[index];

  useEffect(() => {
    if (!photo) { onClose(); return; }
    let live = true;
    imageUrl(photo.id, 'thumb').then((u) => live && setUrl((cur) => cur ?? u));
    imageUrl(photo.id, 'full').then((u) => live && u && setUrl(u));
    // Warm up neighbours for quick swiping.
    [photos[index - 1], photos[index + 1]].forEach((p) => p && imageUrl(p.id, 'full'));
    return () => { live = false; };
  }, [photo?.id]);

  const go = (d: number) => {
    const next = photos[index + d];
    if (next) { setUrl(null); setId(next.id); }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Escape') onClose();
      else if (e.key === 'f' && photo) patchPhoto(photo.id, { favorite: !photo.favorite });
    };
    window.addEventListener('keydown', k);
    document.body.classList.add('no-scroll');
    return () => { window.removeEventListener('keydown', k); document.body.classList.remove('no-scroll'); };
  });

  if (!photo) return null;
  const d = photo.taken ? parseYMD(photo.taken) : null;
  const age = d && birth ? ageInMonths(birth, d) : null;
  const holiday = d ? holidayOn(d, birth) : null;

  async function del() {
    if (!confirm('Remove this photo from the baby book? (It stays in your camera roll.)')) return;
    const next = photos[index + 1] ?? photos[index - 1];
    await removePhotos([photo.id]);
    if (next) { setUrl(null); setId(next.id); } else onClose();
  }

  return (
    <div class="viewer" role="dialog" aria-modal="true">
      <div class="viewer-top">
        <button class="icon-btn light" onClick={onClose} aria-label="Close">✕</button>
        <span class="viewer-count">{index + 1} / {photos.length}</span>
        <button class={`icon-btn light heart ${photo.favorite ? 'on' : ''}`} aria-pressed={photo.favorite}
          aria-label={photo.favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => patchPhoto(photo.id, { favorite: !photo.favorite })}>{photo.favorite ? '♥' : '♡'}</button>
      </div>
      <div class="viewer-stage"
        onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
        onTouchEnd={(e) => {
          const s = touch.current; touch.current = null;
          if (!s || e.touches.length) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - s.x, dy = t.clientY - s.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
          else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose();
        }}>
        {index > 0 && <button class="nav prev" onClick={() => go(-1)} aria-label="Previous">‹</button>}
        {url && <img src={url} alt="" />}
        {index < photos.length - 1 && <button class="nav next" onClick={() => go(1)} aria-label="Next">›</button>}
      </div>
      <div class="viewer-info">
        <div>
          {d ? (
            <>
              <div class="viewer-age">{age !== null ? ageShort(age) : ''}{holiday && <span class="badge">{holiday.emoji} {holiday.name}</span>}</div>
              <div class="viewer-date">{formatLong(d)}{photo.dateSource === 'exif' ? ` · ${formatTime(photo.taken!)}` : ''}{photo.dateSource === 'manual' ? ' · date set by you' : ''}</div>
            </>
          ) : <div class="viewer-age">Needs a date</div>}
        </div>
        <div class="row">
          {photo.printed && <button class="btn small light ghost" title="Tap to unmark" onClick={() => patchPhoto(photo.id, { printed: false })}>Printed ✓</button>}
          <button class="btn small light" onClick={() => setEditing(true)}>{d ? 'Change date' : 'Add date'}</button>
          <button class="btn small light ghost" onClick={del}>Remove</button>
        </div>
      </div>
      {editing && (
        <Sheet title={d ? 'Change date' : 'When was this taken?'} onClose={() => setEditing(false)}>
          <DateEditor photos={[photo]} onCancel={() => setEditing(false)} onSave={async (taken) => {
            await patchPhoto(photo.id, { taken, dateSource: taken ? 'manual' : null });
            setEditing(false);
          }} />
        </Sheet>
      )}
    </div>
  );
}
