import { useState } from 'preact/hooks';
import { formatShortYear, parseYMD } from '../lib/dates';
import type { Photo } from '../lib/types';

export function DateEditor({ photos, onSave, onCancel }: { photos: Photo[]; onSave: (taken: string | null) => void; onCancel: () => void }) {
  const first = photos[0];
  const [date, setDate] = useState(first?.taken?.slice(0, 10) ?? '');
  const [time, setTime] = useState(first?.taken?.slice(11, 16) ?? '');

  const suggestions = new Map<string, string>();
  for (const p of photos.slice(0, 1)) {
    if (p.nameDate) suggestions.set(p.nameDate, 'from the file name');
    if (p.fileDate && !suggestions.has(p.fileDate)) suggestions.set(p.fileDate, 'from the file');
  }

  return (
    <div class="date-editor">
      {photos.length > 1 && <p class="muted">Set the same date for {photos.length} photos.</p>}
      {suggestions.size > 0 && (
        <div class="suggestions">
          {[...suggestions].map(([s, why]) => {
            const d = parseYMD(s)!;
            return (
              <button key={s} class="chip" onClick={() => { setDate(s.slice(0, 10)); setTime(s.slice(11, 16)); }}>
                {formatShortYear(d)} <span class="muted small">{why}</span>
              </button>
            );
          })}
        </div>
      )}
      <div class="row">
        <label class="field grow">
          <span>Date</span>
          <input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Time (optional)</span>
          <input type="time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="row end">
        {first?.taken && photos.length === 1 && <button class="btn ghost" onClick={() => onSave(null)}>Remove date</button>}
        <button class="btn" onClick={onCancel}>Cancel</button>
        <button class="btn primary" disabled={!date} onClick={() => onSave(`${date}T${time || '12:00'}:00`)}>Save</button>
      </div>
    </div>
  );
}
