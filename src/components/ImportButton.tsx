import { useEffect, useRef, useState } from 'preact/hooks';
import { importFiles, type ImportProgress } from '../lib/importer';
import { requestPersist } from '../lib/storage';
import { reloadPhotos } from '../store';
import { Sheet } from './Sheet';

// Import state lives outside any one button, so progress survives the
// screen changing underneath it (e.g. the empty state turning into the timeline).
interface ImportState { progress: ImportProgress; finished: boolean }
let current: ImportState | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = (s: ImportState | null) => { current = s; listeners.forEach((l) => l()); };

async function startImport(files: File[]) {
  if (current && !current.finished) return;
  requestPersist();
  controller = new AbortController();
  let lastReload = 0;
  emit({ progress: { done: 0, total: files.length, added: 0, duplicates: 0, dated: 0, failed: [] }, finished: false });
  const result = await importFiles(files, (p) => {
    if (current) emit({ ...current, progress: p });
    // Let new photos appear in the timeline as they arrive.
    if (p.added - lastReload >= 25) { lastReload = p.added; reloadPhotos(); }
  }, controller.signal);
  await reloadPhotos();
  if (current) emit({ progress: result, finished: true });
}

export function ImportButton({ label = 'Add photos', class: cls = 'btn primary' }: { label?: string; class?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button class={cls} onClick={() => input.current?.click()}>{label}</button>
      <input ref={input} type="file" multiple hidden accept="image/*,.heic,.heif" onChange={(e) => {
        const el = e.target as HTMLInputElement;
        const files = el.files ? [...el.files] : [];
        el.value = '';
        if (files.length) startImport(files);
      }} />
    </>
  );
}

export function ImportSheet() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!current) return null;
  const { progress, finished } = current;
  const close = () => { controller?.abort(); emit(null); };
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <Sheet title={finished ? 'All tucked in' : 'Adding photos…'} onClose={close}>
      <div class="progress"><div class="progress-fill" style={{ width: `${pct}%` }} /></div>
      <p class="muted center">
        {progress.done} of {progress.total}
        {progress.added ? ` · ${progress.added} added` : ''}
        {progress.dated ? ` · ${progress.dated} dates found` : ''}
        {progress.duplicates ? ` · ${progress.duplicates} already here` : ''}
      </p>
      {!finished && <p class="muted center small">Keep this screen open. Everything stays on this device.</p>}
      {progress.failed.length > 0 && (
        <details class="failed">
          <summary>{progress.failed.length} couldn't be read</summary>
          <ul>{progress.failed.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </details>
      )}
      <div class="row end">
        <button class={finished ? 'btn primary' : 'btn'} onClick={close}>{finished ? 'Done' : 'Stop'}</button>
      </div>
    </Sheet>
  );
}
