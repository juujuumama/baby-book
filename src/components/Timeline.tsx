import { useMemo, useState } from 'preact/hooks';
import { formatRange, formatShort, monthLabel, parseYMD, weekday } from '../lib/dates';
import { buildTimeline, type MonthGroup } from '../lib/timeline';
import type { Photo } from '../lib/types';
import { patchPhoto, useStore } from '../store';
import { ImportButton } from './ImportButton';
import { PhotoViewer } from './PhotoViewer';
import { Thumb } from './Thumb';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function PhotoTile({ photo, onOpen }: { photo: Photo; onOpen: (p: Photo) => void }) {
  return (
    <div class={`tile ${photo.favorite ? 'fav' : ''}`}>
      <button class="tile-open" onClick={() => onOpen(photo)} aria-label="Open photo"><Thumb photo={photo} /></button>
      {photo.printed && <span class="tile-printed" title="You have a print of this">printed</span>}
      <button class={`tile-heart ${photo.favorite ? 'on' : ''}`} aria-pressed={photo.favorite}
        aria-label={photo.favorite ? 'Remove from favorites' : 'Add to favorites'}
        onClick={() => patchPhoto(photo.id, { favorite: !photo.favorite })}>{photo.favorite ? '♥' : '♡'}</button>
    </div>
  );
}

function chipLabel(n: number) {
  if (n < 0) return 'Before';
  if (n === 0) return 'NB';
  return String(n);
}

export function Timeline({ onGoUndated }: { onGoUndated: () => void }) {
  const { photos, settings } = useStore();
  const birth = parseYMD(settings.birthDate);
  const [favOnly, setFavOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const timeline = useMemo(() => buildTimeline(photos, birth), [photos, settings.birthDate]);
  const months = useMemo(() => {
    if (!favOnly) return timeline.months;
    return timeline.months.map((m) => ({
      ...m,
      days: m.days.map((d) => ({ ...d, photos: d.photos.filter((p) => p.favorite) })).filter((d) => d.photos.length),
    })).filter((m) => m.days.length);
  }, [timeline, favOnly]);
  const flat = useMemo(() => months.flatMap((m) => m.days.flatMap((d) => d.photos)), [months]);

  if (!photos.length) {
    return (
      <div class="empty card">
        <div class="empty-art" aria-hidden="true">🧸</div>
        <h2>Let's fill the book</h2>
        <p>Choose photos from your camera roll. They're copied into this app on your phone, sorted by age, and never uploaded anywhere.</p>
        <p class="muted small">Tip: you can select a whole month at a time in the photo picker.</p>
        <ImportButton label="Choose photos" />
      </div>
    );
  }

  return (
    <div class="timeline">
      <div class="toolbar">
        <nav class="month-chips" aria-label="Jump to month">
          {timeline.months.map((m) => (
            <a key={m.month} class={`chip ${m.favorites ? 'has-fav' : ''}`} href={`#m${m.month}`}
              onClick={(e) => { e.preventDefault(); document.getElementById(`m${m.month}`)?.scrollIntoView({ behavior: 'smooth' }); }}>
              {chipLabel(m.month)}
            </a>
          ))}
        </nav>
        <div class="row">
          <button class={`chip toggle ${favOnly ? 'on' : ''}`} aria-pressed={favOnly} onClick={() => setFavOnly(!favOnly)}>♥ Favorites</button>
          <ImportButton label="+ Add" class="btn small primary" />
        </div>
      </div>

      {timeline.undated.length > 0 && (
        <button class="notice" onClick={onGoUndated}>
          <span>📮 {timeline.undated.length} {timeline.undated.length === 1 ? 'photo needs' : 'photos need'} a date</span>
          <span aria-hidden="true">›</span>
        </button>
      )}

      {months.map((m) => <MonthSection key={m.month} m={m} onOpen={(p) => setOpen(p.id)} />)}
      {favOnly && !months.length && <p class="muted center">No favorites yet. Tap the ♡ on a photo to pick it.</p>}

      {open && <PhotoViewer photos={flat} startId={open} birth={birth} onClose={() => setOpen(null)} />}
    </div>
  );
}

function MonthSection({ m, onOpen }: { m: MonthGroup; onOpen: (p: Photo) => void }) {
  const count = m.days.reduce((n, d) => n + d.photos.length, 0);
  const printed = m.photos.filter((p) => p.printed).length;
  const daysWithPhotos = new Set(m.days.map((d) => d.key));
  return (
    <section class={`month tint-${((m.month % 3) + 3) % 3}`} id={`m${m.month}`}>
      <header class="month-head">
        <h2>{monthLabel(m.month)}</h2>
        <p class="month-meta">
          {m.start && m.end ? formatRange(m.start, m.end) : 'Bump & before'}
          {' · '}{count} {count === 1 ? 'photo' : 'photos'}
          {m.favorites > 0 && <> · <span class="fav-count">♥ {m.favorites}</span></>}
          {printed > 0 && <> · {printed} printed</>}
        </p>
        {m.holidays.length > 0 && (
          <div class="holidays">
            {m.holidays.map(({ date, holiday }) => {
              const key = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
              return (
                <span key={key} class={`badge ${daysWithPhotos.has(key) ? '' : 'dim'}`} title={formatShort(date)}>
                  {holiday.emoji} {holiday.name}
                </span>
              );
            })}
          </div>
        )}
      </header>
      <div class="days">
      {m.days.map((d) => (
        <div class="day" key={d.key}>
          <h3 class="day-head">
            {DAYS[weekday(d.date)]}, {formatShort(d.date)}
            {d.holiday && <span class="badge">{d.holiday.emoji} {d.holiday.name}</span>}
          </h3>
          <div class="day-photos">{d.photos.map((p) => <PhotoTile key={p.id} photo={p} onOpen={onOpen} />)}</div>
        </div>
      ))}
      </div>
    </section>
  );
}
