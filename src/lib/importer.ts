import { hasDedupeKey, newId, savePhoto } from './db';
import { dateFromName, readMeta } from './exif';
import { closeDrawable, decodeImage, FULL_MAX_EDGE, imageSize, resizeToJpeg, THUMB_MAX_EDGE } from './image';
import { localStringFromDate } from './dates';
import type { Photo } from './types';

export interface ImportProgress {
  done: number;
  total: number;
  added: number;
  duplicates: number;
  failed: string[];
  current?: string;
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * Import photos one at a time. Sequential on purpose: iPhones run out of
 * image memory quickly when decoding several 12 MP photos at once.
 */
export async function importFiles(files: File[], onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<ImportProgress> {
  const p: ImportProgress = { done: 0, total: files.length, added: 0, duplicates: 0, failed: [] };
  onProgress({ ...p });
  for (const file of files) {
    if (signal?.aborted) break;
    p.current = file.name;
    onProgress({ ...p });
    try {
      const added = await importOne(file);
      if (added) p.added++;
      else p.duplicates++;
    } catch (err) {
      if ((err as DOMException)?.name === 'QuotaExceededError') {
        p.failed.push(`${file.name} (device storage is full)`);
        p.done++;
        break;
      }
      console.warn('Import failed', file.name, err);
      p.failed.push(file.name);
    }
    p.done++;
    onProgress({ ...p });
    await yieldToUI();
  }
  p.current = undefined;
  onProgress({ ...p });
  return p;
}

async function importOne(file: File): Promise<boolean> {
  const meta = await readMeta(file);
  const src = await decodeImage(file);
  const { w: origWidth, h: origHeight } = imageSize(src);

  // Same moment + same shape = same photo, even if one copy is HEIC and the
  // other a JPEG the phone converted.
  const dims = [origWidth, origHeight].sort((a, b) => a - b).join('x');
  const dedupeKey = meta.taken ? `t:${meta.taken}|${meta.subSec ?? ''}|${dims}` : `f:${file.name}|${file.size}`;
  if (await hasDedupeKey(dedupeKey)) {
    closeDrawable(src);
    return false;
  }

  try {
    const full = await resizeToJpeg(src, FULL_MAX_EDGE, 0.9);
    const thumb = await resizeToJpeg(src, THUMB_MAX_EDGE, 0.8);
    const photo: Photo = {
      id: newId(),
      taken: meta.taken,
      dateSource: meta.taken ? 'exif' : null,
      fileDate: file.lastModified ? localStringFromDate(new Date(file.lastModified)) : null,
      nameDate: dateFromName(file.name),
      fileName: file.name,
      width: full.width,
      height: full.height,
      origWidth,
      origHeight,
      camera: meta.camera,
      dedupeKey,
      favorite: false,
      addedAt: Date.now(),
    };
    await savePhoto(photo, full.blob, thumb.blob);
    return true;
  } finally {
    closeDrawable(src);
  }
}
