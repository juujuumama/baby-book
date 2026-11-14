import { useEffect, useRef, useState } from 'preact/hooks';
import { createBackup, restoreBackup, saveFiles, type BackupProgress } from '../lib/backup';
import { formatBytes, requestPersist, storageStatus, type StorageStatus } from '../lib/storage';
import { loadAll, saveSettings, useStore, wipeEverything } from '../store';
import { InstallHint } from './InstallHint';
import { Sheet } from './Sheet';

export function SettingsView() {
  const { settings, photos } = useStore();
  const [name, setName] = useState(settings.babyName);
  const [birth, setBirth] = useState(settings.birthDate);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [busy, setBusy] = useState<{ title: string; p: BackupProgress; message?: string; done?: boolean; files?: File[] } | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);

  const refresh = () => storageStatus().then(setStatus);
  useEffect(() => { refresh(); }, [photos.length]);

  const dirty = name !== settings.babyName || birth !== settings.birthDate;

  async function backup() {
    setBusy({ title: 'Packing your backup…', p: { done: 0, total: photos.length } });
    try {
      const files = await createBackup((p) => setBusy((b) => b && { ...b, p }));
      const total = files.reduce((n, f) => n + f.size, 0);
      // The share sheet needs a fresh tap, so hand over a button instead of opening it here.
      setBusy((b) => b && { ...b, title: 'Backup ready', files,
        message: `${files.length > 1 ? `${files.length} files` : '1 file'} · ${formatBytes(total)}. Tap Save, choose "Save to Files", and pick iCloud Drive.` });
    } catch (err) {
      setBusy((b) => b && { ...b, done: true, title: 'Backup failed', message: String((err as Error).message ?? err) });
    }
  }

  async function restore(list: FileList | null) {
    const files = list ? [...list] : [];
    if (restoreInput.current) restoreInput.current.value = '';
    if (!files.length) return;
    requestPersist();
    setBusy({ title: 'Restoring…', p: { done: 0, total: 0 } });
    try {
      const r = await restoreBackup(files, (p) => setBusy((b) => b && { ...b, p }));
      await loadAll();
      setBusy((b) => b && { ...b, done: true, title: 'Restored', message: `${r.added} photos restored${r.skipped ? `, ${r.skipped} were already here` : ''}.` });
    } catch (err) {
      setBusy((b) => b && { ...b, done: true, title: 'Restore failed', message: String((err as Error).message ?? err) });
    }
  }

  async function share(files: File[]) {
    const how = await saveFiles(files);
    if (how === 'cancelled') return;
    setBusy((b) => b && { ...b, done: true, files: undefined, title: 'Backup saved',
      message: 'Keep this file somewhere safe, like iCloud Drive. You can restore from it on any device.' });
  }

  const pct = busy && busy.p.total ? Math.round((busy.p.done / busy.p.total) * 100) : 0;

  return (
    <div class="settings">
      <section class="card">
        <h2>About the baby</h2>
        <label class="field">
          <span>First name or nickname (optional)</span>
          <input type="text" value={name} autocomplete="off" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Birth date</span>
          <input type="date" value={birth} onInput={(e) => setBirth((e.target as HTMLInputElement).value)} />
        </label>
        <p class="muted small">Used to sort photos into months of age. It's stored only on this device.</p>
        <div class="row end">
          {saved && !dirty && <span class="muted small">Saved ✓</span>}
          <button class="btn primary" disabled={!dirty || !birth} onClick={async () => { await saveSettings({ ...settings, babyName: name.trim(), birthDate: birth }); setSaved(true); }}>Save</button>
        </div>
      </section>

      <section class="card">
        <h2>Keeping photos safe</h2>
        <InstallHint />
        <ul class="facts">
          <li><strong>{photos.length}</strong> photos in the book{status?.usage != null && <> · using {formatBytes(status.usage)}{status.quota ? ` of ${formatBytes(status.quota)} available` : ''}</>}</li>
          <li>
            Protected storage: {status?.persisted ? <strong>on ✓</strong> : <>
              <strong>not yet</strong>{' '}
              <button class="btn small" onClick={async () => { await requestPersist(); refresh(); }}>Turn on</button>
            </>}
          </li>
        </ul>
        <p class="muted small">Your photos live only on this device. Make a backup after each big batch of photos and save it to iCloud Drive. If the phone is lost or the app is deleted, you can restore everything from that file.</p>
        <div class="row">
          <button class="btn primary" disabled={!photos.length} onClick={backup}>Back up everything</button>
          <button class="btn" onClick={() => restoreInput.current?.click()}>Restore from backup</button>
          <input ref={restoreInput} type="file" hidden multiple accept=".zip,application/zip" onChange={(e) => restore((e.target as HTMLInputElement).files)} />
        </div>
      </section>

      <section class="card danger-zone">
        <h2>Start over</h2>
        <p class="muted small">Deletes every photo and setting from this app on this device. Your camera roll isn't touched.</p>
        <button class="btn ghost danger" onClick={async () => {
          const typed = prompt('This erases the whole baby book on this device. Type ERASE to confirm.');
          if (typed?.trim().toUpperCase() === 'ERASE') await wipeEverything();
        }}>Erase this book</button>
      </section>

      <p class="muted small center footer-note">Baby Book works offline and never uploads your photos.</p>

      {busy && (
        <Sheet title={busy.title} onClose={() => (busy.done || busy.files) && setBusy(null)}>
          {!busy.done && !busy.files && <div class="progress"><div class="progress-fill" style={{ width: `${pct}%` }} /></div>}
          {busy.p.total > 0 && !busy.done && !busy.files && <p class="muted center">{busy.p.done} of {busy.p.total}</p>}
          {busy.message && <p>{busy.message}</p>}
          {busy.files && <div class="row end"><button class="btn" onClick={() => setBusy(null)}>Not now</button><button class="btn primary" onClick={() => share(busy.files!)}>Save backup</button></div>}
          {busy.done && <div class="row end"><button class="btn primary" onClick={() => setBusy(null)}>OK</button></div>}
        </Sheet>
      )}
    </div>
  );
}
