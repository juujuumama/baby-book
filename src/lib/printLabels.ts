import { ageShort, formatShort, parseYMD, type YMD } from './dates';
import { buildTimeline } from './timeline';
import type { Photo } from './types';

export interface PrintInfo {
  photo: Photo;
  month: number;
  /** 1-based position of this photo within its month, by time taken. */
  index: number;
  total: number;
  date: YMD;
}

/** Where every dated photo sits in its month ("#14 of 38"). */
export function monthPositions(photos: Photo[], birth: YMD | null): Map<string, PrintInfo> {
  const out = new Map<string, PrintInfo>();
  if (!birth) return out;
  for (const m of buildTimeline(photos, birth).months) {
    m.photos.forEach((p, i) => out.set(p.id, { photo: p, month: m.month, index: i + 1, total: m.photos.length, date: parseYMD(p.taken!)! }));
  }
  return out;
}

export function shortLabel(info: PrintInfo): string {
  return `${ageShort(info.month)} · ${formatShort(info.date)}`;
}

export function fullLabel(info: PrintInfo): string {
  return `${shortLabel(info)} · #${info.index} of ${info.total}`;
}

function minutes(taken: string | null): number | null {
  const m = taken && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(taken);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}

/** Photos taken within a few minutes of each other sort the same, so either match is fine. */
export function sameMomentFn(byId: Map<string, Photo>) {
  return (a: string, b: string) => {
    const x = minutes(byId.get(a)?.taken ?? null), y = minutes(byId.get(b)?.taken ?? null);
    return x !== null && y !== null && Math.abs(x - y) <= 3;
  };
}

/** Order photo ids by time taken (undated last). */
export function byTakenIds(ids: string[], byId: Map<string, Photo>): string[] {
  return [...ids].sort((a, b) => (byId.get(a)?.taken ?? '￿').localeCompare(byId.get(b)?.taken ?? '￿'));
}
