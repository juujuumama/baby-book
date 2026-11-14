import { addDays, weekday, type YMD } from './dates';

export interface Holiday { name: string; emoji: string }

function nthWeekday(y: number, m: number, dow: number, nth: number): YMD {
  const first = weekday({ y, m, d: 1 });
  return { y, m, d: 1 + ((dow - first + 7) % 7) + (nth - 1) * 7 };
}

function lastWeekday(y: number, m: number, dow: number): YMD {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekday({ y, m, d: lastDay });
  return { y, m, d: lastDay - ((last - dow + 7) % 7) };
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
export function easter(y: number): YMD {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y, m: month, d: day };
}

const cache = new Map<number, Map<string, Holiday>>();

/** US holidays and family occasions for a year, keyed by "M-D". */
export function holidaysForYear(y: number): Map<string, Holiday> {
  const hit = cache.get(y);
  if (hit) return hit;
  const list: [YMD, string, string][] = [
    [{ y, m: 1, d: 1 }, "New Year's Day", '🎉'],
    [{ y, m: 2, d: 14 }, "Valentine's Day", '💕'],
    [{ y, m: 3, d: 17 }, "St. Patrick's Day", '🍀'],
    [easter(y), 'Easter', '🐣'],
    [nthWeekday(y, 5, 0, 2), "Mother's Day", '💐'],
    [lastWeekday(y, 5, 1), 'Memorial Day', '🇺🇸'],
    [nthWeekday(y, 6, 0, 3), "Father's Day", '👔'],
    [{ y, m: 7, d: 4 }, 'Fourth of July', '🎆'],
    [nthWeekday(y, 9, 1, 1), 'Labor Day', '🌻'],
    [{ y, m: 10, d: 31 }, 'Halloween', '🎃'],
    [nthWeekday(y, 11, 4, 4), 'Thanksgiving', '🦃'],
    [{ y, m: 12, d: 24 }, 'Christmas Eve', '🎄'],
    [{ y, m: 12, d: 25 }, 'Christmas', '🎄'],
    [{ y, m: 12, d: 31 }, "New Year's Eve", '🥂'],
  ];
  const map = new Map<string, Holiday>();
  for (const [date, name, emoji] of list) map.set(`${date.m}-${date.d}`, { name, emoji });
  cache.set(y, map);
  return map;
}

export function holidayOn(date: YMD, birth?: YMD | null): Holiday | null {
  if (birth && date.m === birth.m && date.d === birth.d && date.y > birth.y) {
    const age = date.y - birth.y;
    return { name: age === 1 ? 'First birthday' : `Birthday #${age}`, emoji: '🎂' };
  }
  if (birth && date.y === birth.y && date.m === birth.m && date.d === birth.d) {
    return { name: 'Birth day', emoji: '👶' };
  }
  return holidaysForYear(date.y).get(`${date.m}-${date.d}`) ?? null;
}

/** Holidays that fall inside an inclusive date range, in order. */
export function holidaysInRange(start: YMD, end: YMD, birth?: YMD | null): { date: YMD; holiday: Holiday }[] {
  const out: { date: YMD; holiday: Holiday }[] = [];
  for (let d = start, i = 0; i < 400; d = addDays(d, 1), i++) {
    const h = holidayOn(d, birth);
    if (h) out.push({ date: d, holiday: h });
    if (d.y === end.y && d.m === end.m && d.d === end.d) break;
  }
  return out;
}
