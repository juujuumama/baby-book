import exifr from 'exifr';
import { localStringFromDate } from './dates';

export interface PhotoMeta {
  taken: string | null;
  subSec: string | null;
  camera: string | null;
}

function toLocal(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return localStringFromDate(v);
  if (typeof v === 'string') {
    // "2025:06:12 14:03:00" (unrevived EXIF format)
    const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  return null;
}

export async function readMeta(file: Blob): Promise<PhotoMeta> {
  try {
    const t = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'SubSecTimeOriginal', 'Make', 'Model'],
      // Keep the camera's local wall-clock time; don't let offsets shift the day.
      reviveValues: true,
    });
    if (!t) return { taken: null, subSec: null, camera: null };
    const taken = toLocal(t.DateTimeOriginal) ?? toLocal(t.CreateDate) ?? toLocal(t.DateTimeDigitized);
    const camera = [t.Make, t.Model].filter(Boolean).join(' ') || null;
    return { taken, subSec: t.SubSecTimeOriginal != null ? String(t.SubSecTimeOriginal) : null, camera };
  } catch {
    return { taken: null, subSec: null, camera: null };
  }
}

/** Dates that sometimes hide in file names, e.g. "IMG_20250612_140300.jpg", "Screenshot 2025-06-12 at 2.03.00 PM.png". */
export function dateFromName(name: string): string | null {
  const m = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[ _T-]*(?:at )?([01]\d|2[0-3])[.:_-]?([0-5]\d)[.:_-]?([0-5]\d))?/.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '12'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
}
