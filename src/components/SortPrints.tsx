import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseYMD } from '../lib/dates';
import { monthPositions } from '../lib/printLabels';
import type { Sig } from '../lib/vision/match';
import { loadSigs } from '../lib/vision/browser';
import { useStore } from '../store';
import { ImportButton } from './ImportButton';
import { LiveSort } from './LiveSort';
import { TableSort } from './TableSort';

type Mode = { kind: 'home' } | { kind: 'table'; file: File } | { kind: 'live' };

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

  const onFile = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = '';
    if (file) setMode({ kind: 'table', file });
  };

  if (!photos.length) {
    return (
      <div class="empty card">
        <div class="empty-art" aria-hidden="true">🗂️</div>
        <h2>Add photos first</h2>
        <p>To sort your prints, first add the same months' photos from your camera roll. The app matches each print to one of them.</p>
        <ImportButton label="Choose photos" />
      </div>
    );
  }

  if (mode.kind === 'table' && sigs) {
    return <TableSort file={mode.file} sigs={sigs} positions={positions} onDone={() => setMode({ kind: 'home' })}
      onAnother={() => takeInput.current?.click()} inputs={inputs()} />;
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
  return (
    <div class="sort">
      <div class="card intro">
        <h2>Sort your prints</h2>
        <p class="muted">Match the prints in your envelopes to your photos. Each one gets its age, date, and place in order.</p>
        {prep && (
          <>
            <div class="progress"><div class="progress-fill" style={{ width: `${Math.round((prep.done / Math.max(1, prep.total)) * 100)}%` }} /></div>
            <p class="muted small center">Getting your photos ready for matching… {prep.done} of {prep.total} (only needed once)</p>
          </>
        )}
      </div>

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
