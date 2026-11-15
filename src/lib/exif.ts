import exifr from 'exifr';
import { localStringFromDate } from './dates';
import { heifExifTiff, isHeif } from './heicExif';

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

const DATE_KEYS = ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'DateCreated', 'DateTimeCreated', 'DigitalCreationDate'];

function fromTags(t: Record<string, unknown> | undefined | null): PhotoMeta | null {
  if (!t || typeof t !== 'object') return null;
  let taken: string | null = null;
  for (const k of DATE_KEYS) { taken = toLocal(t[k]); if (taken) break; }
  const camera = [t.Make, t.Model].filter(Boolean).join(' ') || null;
  return { taken, subSec: t.SubSecTimeOriginal != null ? String(t.SubSecTimeOriginal) : null, camera };
}

const FULL = { tiff: true, exif: true, xmp: true, iptc: true, gps: false, ifd1: false, icc: false, mergeOutput: true, reviveValues: true } as const;

/**
 * When a photo was taken, read from its metadata. Tries a quick read, then a
 * thorough one (XMP/IPTC too), and for HEIC files reads the EXIF block
 * directly, since the general reader can't always find it in iPhone HEICs.
 */
export async function readMeta(file: Blob): Promise<PhotoMeta> {
  let best: PhotoMeta = { taken: null, subSec: null, camera: null };
  const keep = (m: PhotoMeta | null) => { if (m && (m.taken || !best.taken)) best = { ...best, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)) } as PhotoMeta; };
  try {
    keep(fromTags(await exifr.parse(file, { pick: [...DATE_KEYS, 'SubSecTimeOriginal', 'Make', 'Model'], reviveValues: true })));
  } catch { /* try harder below */ }
  if (best.taken) return best;
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (isHeif(head)) {
      const tiff = heifExifTiff(new Uint8Array(await file.arrayBuffer()));
      if (tiff) keep(fromTags(await exifr.parse(tiff, FULL)));
      if (best.taken) return best;
    }
  } catch { /* fall through */ }
  try {
    keep(fromTags(await exifr.parse(new Uint8Array(await file.arrayBuffer()), FULL)));
  } catch { /* no metadata */ }
  return best;
}

/** Dates that sometimes hide in file names, e.g. "IMG_20250612_140300.jpg", "Screenshot 2025-06-12 at 2.03.00 PM.png". */
export function dateFromName(name: string): string | null {
  const m = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[ _T-]*(?:at )?([01]\d|2[0-3])[.:_-]?([0-5]\d)[.:_-]?([0-5]\d))?/.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '12'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
}
