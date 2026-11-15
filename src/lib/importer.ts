import { getPhotoByDedupeKey, hasDedupeKey, newId, putSig, savePhoto, updatePhoto } from './db';
import { sigFromSource } from './vision/browser';
import { dateFromName, readMeta } from './exif';
import { closeDrawable, decodeImage, FULL_MAX_EDGE, imageSize, resizeToJpeg, THUMB_MAX_EDGE } from './image';
import { localStringFromDate } from './dates';
import type { Photo } from './types';

export interface ImportProgress {
  done: number;
  total: number;
  added: number;
  duplicates: number;
  /** Photos already in the book whose missing date was found this time. */
  dated: number;
  failed: string[];
  current?: string;
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * Import photos one at a time. Sequential on purpose: iPhones run out of
 * image memory quickly when decoding several 12 MP photos at once.
 */
export async function importFiles(files: File[], onProgress: (p: ImportProgress) => void, signal?: AbortSignal): Promise<ImportProgress> {
  const p: ImportProgress = { done: 0, total: files.length, added: 0, duplicates: 0, dated: 0, failed: [] };
  onProgress({ ...p });
  for (const file of files) {
    if (signal?.aborted) break;
    p.current = file.name;
    onProgress({ ...p });
    try {
      const r = await importOne(file);
      if (r === 'added') p.added++;
      else if (r === 'dated') p.dated++;
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

async function importOne(file: File): Promise<'added' | 'dated' | 'duplicate'> {
  const meta = await readMeta(file);
  // Added before without a date (the same file again)? Fill the date in now.
  const fileKey = `f:${file.name}|${file.size}`;
  const earlier = await getPhotoByDedupeKey(fileKey);
  if (earlier) {
    if (!earlier.taken && meta.taken) {
      await updatePhoto(earlier.id, { taken: meta.taken, dateSource: 'exif', camera: earlier.camera ?? meta.camera });
      return 'dated';
    }
    return 'duplicate';
  }
  const src = await decodeImage(file);
  const { w: origWidth, h: origHeight } = imageSize(src);

  // Same moment + same shape = same photo, even if one copy is HEIC and the
  // other a JPEG the phone converted.
  const dims = [origWidth, origHeight].sort((a, b) => a - b).join('x');
  const dedupeKey = meta.taken ? `t:${meta.taken}|${meta.subSec ?? ''}|${dims}` : fileKey;
  if (await hasDedupeKey(dedupeKey)) {
    closeDrawable(src);
    return 'duplicate';
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
    try {
      await putSig(photo.id, sigFromSource(src as CanvasImageSource & { width: number; height: number }));
    } catch { /* rebuilt later from the thumbnail */ }
    return 'added';
  } finally {
    closeDrawable(src);
  }
}
