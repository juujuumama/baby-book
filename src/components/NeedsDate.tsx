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
