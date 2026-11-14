import { countPhotos, getAllPhotos, getBlob, getSettings, hasDedupeKey, getPhoto, savePhoto, saveSettings } from './db';
import type { Photo, Settings } from './types';
import { readZip, ZipWriter } from './zip';

const FORMAT = 'baby-book-backup';
/** Split very large libraries so each file stays easy to save and move. */
const PART_LIMIT = 1.5 * 1024 ** 3;

interface Manifest {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  part: number;
  parts: number;
  settings: Settings;
  photos: Photo[];
}

export interface BackupProgress { done: number; total: number }

export async function createBackup(onProgress: (p: BackupProgress) => void): Promise<File[]> {
  const [photos, settings] = await Promise.all([getAllPhotos(), getSettings()]);
  photos.sort((a, b) => a.addedAt - b.addedAt);
  const createdAt = new Date().toISOString();
  const stamp = createdAt.slice(0, 10);

  const groups: { writer: ZipWriter; photos: Photo[] }[] = [];
  let cur = { writer: new ZipWriter(), photos: [] as Photo[] };
  groups.push(cur);
  let done = 0;
  onProgress({ done, total: photos.length });
  for (const photo of photos) {
    const [full, thumb] = await Promise.all([getBlob(photo.id, 'full'), getBlob(photo.id, 'thumb')]);
    if (!full) { done++; continue; }
    if (cur.photos.length && cur.writer.size + full.size > PART_LIMIT) {
      cur = { writer: new ZipWriter(), photos: [] };
      groups.push(cur);
    }
    await cur.writer.add(`photos/${photo.id}.jpg`, full);
    if (thumb) await cur.writer.add(`thumbs/${photo.id}.jpg`, thumb);
    cur.photos.push(photo);
    onProgress({ done: ++done, total: photos.length });
  }

  return Promise.all(groups.map(async (g, i) => {
    const manifest: Manifest = { format: FORMAT, version: 1, createdAt, part: i + 1, parts: groups.length, settings, photos: g.photos };
    await g.writer.add('baby-book.json', JSON.stringify(manifest));
    const suffix = groups.length > 1 ? `-part${i + 1}of${groups.length}` : '';
    return new File([g.writer.finish()], `baby-book-backup-${stamp}${suffix}.zip`, { type: 'application/zip' });
  }));
}

export interface RestoreResult { added: number; skipped: number; settingsRestored: boolean }

export async function restoreBackup(files: File[], onProgress: (p: BackupProgress) => void): Promise<RestoreResult> {
  const result: RestoreResult = { added: 0, skipped: 0, settingsRestored: false };
  const opened = [];
  for (const f of files) {
    const entries = await readZip(f);
    const m = entries.get('baby-book.json');
    if (!m) throw new Error(`${f.name} is not a Baby Book backup.`);
    const manifest = JSON.parse(await m.blob.text()) as Manifest;
    if (manifest.format !== FORMAT) throw new Error(`${f.name} is not a Baby Book backup.`);
    opened.push({ entries, manifest });
  }
  const total = opened.reduce((n, o) => n + o.manifest.photos.length, 0);
  let done = 0;
  onProgress({ done, total });

  const current = await getSettings();
  const incoming = opened[0]?.manifest.settings;
  // A fresh book takes the backup's name and birth date; an existing one keeps its own.
  if (incoming?.birthDate && (!current.birthDate || (await countPhotos()) === 0)) {
    await saveSettings({ ...current, ...incoming });
    result.settingsRestored = true;
  }

  for (const { entries, manifest } of opened) {
    for (const photo of manifest.photos) {
      const full = entries.get(`photos/${photo.id}.jpg`)?.blob;
      const thumb = entries.get(`thumbs/${photo.id}.jpg`)?.blob;
      if (!full || !thumb || (await getPhoto(photo.id)) || (await hasDedupeKey(photo.dedupeKey))) {
        result.skipped++;
      } else {
        // Copy out of the file slice so the database owns real bytes.
        const fullCopy = new Blob([await full.arrayBuffer()], { type: 'image/jpeg' });
        const thumbCopy = new Blob([await thumb.arrayBuffer()], { type: 'image/jpeg' });
        await savePhoto(photo, fullCopy, thumbCopy);
        result.added++;
      }
      onProgress({ done: ++done, total });
    }
  }
  return result;
}

/** Hand files to the iOS share sheet ("Save to Files"), or download them elsewhere. */
export async function saveFiles(files: File[]): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title: 'Baby Book backup' });
      return 'shared';
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return 'cancelled';
      // Fall through to download (e.g. file too large for the share sheet).
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return 'downloaded';
}
