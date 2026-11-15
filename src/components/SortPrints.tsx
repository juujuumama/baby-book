import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseYMD } from '../lib/dates';
import { monthPositions } from '../lib/printLabels';
import type { Sig } from '../lib/vision/match';
import { loadSigs } from '../lib/vision/browser';
import { useStore } from '../store';
import { AddHelp } from './AddHelp';
import { ImportButton } from './ImportButton';
import { LiveSort } from './LiveSort';
import { MergeWalk } from './MergeWalk';
import { clearPiles, removePile, startPile, usePiles, type Pile } from '../lib/sortSession';
import { TableSort } from './TableSort';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (taken: string) => `${MONTHS[+taken.slice(5, 7) - 1]} ${taken.slice(0, 4)}`;

type Mode = { kind: 'home' } | { kind: 'table'; file: File; pile: Pile } | { kind: 'live' } | { kind: 'merge' };

export function SortPrints() {
  const { photos, settings } = useStore();
  const birth = parseYMD(settings.birthDate);
  const [sigs, setSigs] = useState<Map<string, Sig> | null>(null);
  const [prep, setPrep] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'home' });
  const takeInput = useRef<HTMLInputElement>(null);
  const chooseInput = useRef<HTMLInputElement>(null);

  // Fingerprints follow the photo list; rebuild any that are missing.
  const photoKey = photos.map((p) => p.id).join(',');
  useEffect(() => {
    let live = true;
    loadSigs(photos, (done, total) => live && setPrep(total ? { done, total } : null)).then((s) => {
      if (live) { setSigs(s); setPrep(null); }
    });
    return () => { live = false; };
  }, [photoKey]);

  const positions = useMemo(() => monthPositions(photos, birth), [photos, settings.birthDate]);
  const piles = usePiles();
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const usedPiles = piles.filter((p) => p.photoIds.length > 0);

  const onFile = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (file) startPile().then((pile) => setMode({ kind: 'table', file, pile }));
  };

  if (!photos.length) {
    return (
      <div class="card steps">
        <h2>Sort your prints in two steps</h2>
        <ol>
          <li>
            <strong>Add your camera-roll photos</strong> for the months your prints cover. The app matches each print to one of these, so add the originals, not a picture of the prints.
            <div class="row"><ImportButton label="Add camera-roll photos" /></div>
            <AddHelp />
          </li>
          <li class="muted"><strong>Take one photo of your prints</strong> laid out on the floor. You'll do this here once your photos are added.</li>
        </ol>
      </div>
    );
  }

  if (mode.kind === 'table' && sigs) {
    return <TableSort key={mode.pile.id} file={mode.file} pile={mode.pile} sigs={sigs} positions={positions} onDone={() => setMode({ kind: 'home' })}
      onAnother={() => takeInput.current?.click()} inputs={inputs()} />;
  }
  if (mode.kind === 'merge') {
    return <MergeWalk piles={usedPiles} positions={positions} byId={byId} onClose={() => setMode({ kind: 'home' })} />;
  }
  if (mode.kind === 'live' && sigs) {
    return <LiveSort sigs={sigs} positions={positions} onClose={() => setMode({ kind: 'home' })} />;
  }

  function inputs() {
    return (
      <>
        <input ref={takeInput} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
        <input ref={chooseInput} type="file" accept="image/*,.heic,.heif" hidden onChange={onFile} />
      </>
    );
  }

  const ready = !!sigs && !prep;
  const dated = photos.filter((p) => p.taken).map((p) => p.taken!).sort();
  const span = dated.length ? `${fmtMonth(dated[0])} – ${fmtMonth(dated[dated.length - 1])}` : '';
  return (
    <div class="sort">
      <div class="card intro">
        <h2>Sort your prints</h2>
        <p class="muted">Match the prints in your envelopes to your photos. Each one gets its age, date, and place in order.</p>
        <p class="library-note">
          Matching against <strong>{photos.length} {photos.length === 1 ? 'photo' : 'photos'}</strong> in your book{span ? ` (${span})` : ''}.{' '}
          <ImportButton label="Add more" class="link-btn" />
        </p>
        {photos.length < 20 && (
          <p class="warn-note">Only {photos.length} {photos.length === 1 ? 'photo is' : 'photos are'} in your book. Prints can only be matched to photos you've added, so add the camera-roll photos for the months your prints cover first.</p>
        )}
        {prep && (
          <>
            <div class="progress"><div class="progress-fill" style={{ width: `${Math.round((prep.done / Math.max(1, prep.total)) * 100)}%` }} /></div>
            <p class="muted small center">Getting your photos ready for matching… {prep.done} of {prep.total} (only needed once)</p>
          </>
        )}
      </div>

      {usedPiles.length > 0 && (
        <div class="card piles">
          <h3>Your piles so far</h3>
          <p class="muted small">Each floor photo becomes a pile stacked in date order. When every print is sorted into a pile, merge them into one stack.</p>
          <ul class="pile-list">
            {usedPiles.map((p) => (
              <li key={p.id}>
                <span class="pile-badge">{p.label}</span>
                <span class="pile-text">{p.photoIds.length} prints{p.unmatched ? ` · ${p.unmatched} set aside` : ''}</span>
                <button class="link-btn" onClick={() => { if (confirm(`Forget pile ${p.label}?`)) removePile(p.id); }}>Remove</button>
              </li>
            ))}
          </ul>
          <div class="row">
            {usedPiles.length > 1 && <button class="btn primary" onClick={() => setMode({ kind: 'merge' })}>Merge {usedPiles.length} piles into one stack ›</button>}
            <button class="btn ghost small" onClick={() => { if (confirm('Start over and forget all piles? (Your photos stay.)')) clearPiles(); }}>Start over</button>
          </div>
          <p class="muted small">Next batch: pick up the sorted pile, lay out more prints, and take another photo below.</p>
        </div>
      )}

      <div class="mode-cards">
        <div class="card mode-card">
          <div class="mode-art" aria-hidden="true">🃏🃏🃏</div>
          <h3>A whole batch</h3>
          <p class="muted small">Lay prints on the table or floor and take one photo. Each print gets a number showing its order.</p>
          <div class="row">
            <button class="btn primary" disabled={!ready} onClick={() => takeInput.current?.click()}>Take photo</button>
            <button class="btn" disabled={!ready} onClick={() => chooseInput.current?.click()}>Choose photo</button>
          </div>
        </div>
        <div class="card mode-card">
          <div class="mode-art" aria-hidden="true">🖐️🃏</div>
          <h3>One at a time</h3>
          <p class="muted small">Hold up a single print to the camera, and it shows "5 mo · Jun 12 · #14 of 38".</p>
          <div class="row">
            <button class="btn primary" disabled={!ready} onClick={() => setMode({ kind: 'live' })}>Open camera</button>
          </div>
        </div>
      </div>

      <details class="card tips">
        <summary>Tips for good matches</summary>
        <ul>
          <li>Up to 30–40 prints per photo is fine. Fill the frame, and keep every print fully in the shot.</li>
          <li>Use a plain surface that contrasts with the photos, like a dark table, floor, or blanket.</li>
          <li>Small gaps between prints help. Prints that touch or overlap a little usually still work.</li>
          <li>Hold the phone straight above the prints. Stand on a chair for a big batch.</li>
          <li>Avoid glare: turn off overhead lights that reflect in glossy prints.</li>
          <li>Anything it can't match for sure is marked "?" so you can pick the right photo.</li>
        </ul>
      </details>
      {inputs()}
    </div>
  );
}
