import { ageInMonths, monthRange, parseYMD, type YMD } from './dates';
import { holidayOn, holidaysInRange, type Holiday } from './holidays';
import type { Photo } from './types';

export interface DayGroup { date: YMD; key: string; holiday: Holiday | null; photos: Photo[] }

export interface MonthGroup {
  month: number;
  start: YMD | null;
  end: YMD | null;
  photos: Photo[];
  days: DayGroup[];
  favorites: number;
  holidays: { date: YMD; holiday: Holiday }[];
}

export interface Timeline { months: MonthGroup[]; undated: Photo[] }

export function byTaken(a: Photo, b: Photo) {
  return (a.taken ?? '').localeCompare(b.taken ?? '') || a.addedAt - b.addedAt;
}

export function photoMonth(photo: Photo, birth: YMD): number | null {
  const d = photo.taken ? parseYMD(photo.taken) : null;
  return d ? ageInMonths(birth, d) : null;
}

export function buildTimeline(photos: Photo[], birth: YMD | null): Timeline {
  const undated: Photo[] = [];
  const dated = photos.filter((p) => (p.taken ? true : (undated.push(p), false))).sort(byTaken);
  undated.sort((a, b) => a.addedAt - b.addedAt);
  if (!birth) {
    return dated.length ? { months: [], undated: [...dated, ...undated] } : { months: [], undated };
  }

  const byMonth = new Map<number, Photo[]>();
  for (const p of dated) {
    const n = Math.max(-1, ageInMonths(birth, parseYMD(p.taken!)!));
    (byMonth.get(n) ?? byMonth.set(n, []).get(n)!).push(p);
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0] - b[0]).map(([month, list]): MonthGroup => {
    const days: DayGroup[] = [];
    for (const p of list) {
      const key = p.taken!.slice(0, 10);
      let day = days[days.length - 1];
      if (!day || day.key !== key) {
        const date = parseYMD(key)!;
        day = { date, key, holiday: holidayOn(date, birth), photos: [] };
        days.push(day);
      }
      day.photos.push(p);
    }
    const range = month >= 0 ? monthRange(birth, month) : null;
    return {
      month,
      start: range?.start ?? null,
      end: range?.end ?? null,
      photos: list,
      days,
      favorites: list.filter((p) => p.favorite).length,
      holidays: range ? holidaysInRange(range.start, range.end, birth) : [],
    };
  });
  return { months, undated };
}
