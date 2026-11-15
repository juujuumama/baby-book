import { useMemo, useState } from 'preact/hooks';
import { patchPhotos, removePhotos, useStore } from '../store';
import { DateEditor } from './DateEditor';
import { Sheet } from './Sheet';
import { Thumb } from './Thumb';

export function NeedsDate() {
  const { photos } = useStore();
  const undated = useMemo(() => photos.filter((p) => !p.taken).sort((a, b) => a.addedAt - b.addedAt), [photos]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const withNameDate = undated.filter((p) => p.nameDate);
  // File dates are only useful when they're not just the day the photo was added.
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const withFileDate = undated.filter((p) => p.fileDate && p.fileDate.slice(0, 10) !== day(p.addedAt));
  const fileDaysVary = new Set(withFileDate.map((p) => p.fileDate!.slice(0, 10))).size >= 5;
  const types = new Map<string, number>();
  for (const p of undated) { const ext = (/\.([a-z0-9]+)$/i.exec(p.fileName)?.[1] ?? 'other').toUpperCase(); types.set(ext, (types.get(ext) ?? 0) + 1); }

  const toggle = (id: string) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const chosen = undated.filter((p) => selected.has(p.id));

  if (!undated.length) {
    return (
      <div class="empty card">
        <div class="empty-art" aria-hidden="true">🌙</div>
        <h2>Every photo has a date</h2>
        <p>Photos without a date (texted pictures, screenshots, downloads) will wait here until you tell us when they were taken.</p>
      </div>
    );
  }

  return (
    <div class="needs-date">
      <div class="card intro">
        <h2>Needs a date</h2>
        <p class="muted">These photos didn't say when they were taken. Tap to select one or more, then set the date.</p>
        <p class="muted small">By file type: {[...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(' · ')}</p>
        {withFileDate.length >= 10 && fileDaysVary && (
          <button class="btn small" onClick={async () => {
            if (!confirm(`Use the file's own date for ${withFileDate.length} photos? These are usually right but can be the day a photo was saved, so check a few afterwards.`)) return;
            for (const p of withFileDate) await patchPhotos([p.id], { taken: p.fileDate, dateSource: 'manual' });
          }}>Use the files' dates ({withFileDate.length})</button>
        )}
        {withNameDate.length > 0 && (
          <button class="btn small" onClick={async () => {
            for (const p of withNameDate) await patchPhotos([p.id], { taken: p.nameDate, dateSource: 'manual' });
          }}>Use dates found in file names ({withNameDate.length})</button>
        )}
      </div>
      <div class="grid">
        {undated.map((p) => (
          <button key={p.id} class={`tile select ${selected.has(p.id) ? 'selected' : ''}`} aria-pressed={selected.has(p.id)} onClick={() => toggle(p.id)}>
            <Thumb photo={p} />
            <span class="check" aria-hidden="true">✓</span>
          </button>
        ))}
      </div>
      {selected.size > 0 && (
        <div class="action-bar">
          <span>{selected.size} selected</span>
          <div class="row">
            <button class="btn small ghost" onClick={() => setSelected(new Set())}>Clear</button>
            <button class="btn small ghost" onClick={async () => {
              if (!confirm(`Remove ${selected.size} photo(s) from the baby book? (They stay in your camera roll.)`)) return;
              await removePhotos([...selected]);
              setSelected(new Set());
            }}>Remove</button>
            <button class="btn small primary" onClick={() => setEditing(true)}>Set date</button>
          </div>
        </div>
      )}
      {editing && (
        <Sheet title="When were these taken?" onClose={() => setEditing(false)}>
          <DateEditor photos={chosen} onCancel={() => setEditing(false)} onSave={async (taken) => {
            await patchPhotos([...selected], { taken, dateSource: taken ? 'manual' : null });
            setSelected(new Set());
            setEditing(false);
          }} />
        </Sheet>
      )}
    </div>
  );
}
