// All photo dates are kept as *local* wall-clock strings ("2025-06-12T14:03:00")
// exactly as the camera wrote them. That avoids time-zone drift: a photo taken
// at 11pm on Christmas Eve stays on Christmas Eve, wherever the book is opened.

export interface YMD { y: number; m: number; d: number } // m is 1-12

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function parseYMD(s: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function ymdToString({ y, m, d }: YMD): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function compareYMD(a: YMD, b: YMD): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** Calendar-month addition, clamped: Jan 31 + 1 month = Feb 28/29. */
export function addMonths(date: YMD, n: number): YMD {
  const total = date.y * 12 + (date.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

export function addDays(date: YMD, n: number): YMD {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Day of week, 0 = Sunday. */
export function weekday(date: YMD): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

/**
 * Completed months of age on `date`. Month 0 is birth up to the first
 * monthly birthday; negative means before birth.
 */
export function ageInMonths(birth: YMD, date: YMD): number {
  let n = (date.y - birth.y) * 12 + (date.m - birth.m);
  if (compareYMD(addMonths(birth, n), date) > 0) n -= 1;
  return n;
}

/** Inclusive date range covered by month-of-age `n`. */
export function monthRange(birth: YMD, n: number): { start: YMD; end: YMD } {
  return { start: addMonths(birth, n), end: addDays(addMonths(birth, n + 1), -1) };
}

export function formatShort(date: YMD): string {
  return `${MONTHS_SHORT[date.m - 1]} ${date.d}`;
}

export function formatShortYear(date: YMD): string {
  return `${MONTHS_SHORT[date.m - 1]} ${date.d}, ${date.y}`;
}

export function formatLong(date: YMD): string {
  return `${MONTHS_LONG[date.m - 1]} ${date.d}, ${date.y}`;
}

export function formatRange(a: YMD, b: YMD): string {
  return a.y === b.y ? `${formatShort(a)} – ${formatShort(b)}, ${b.y}` : `${formatShortYear(a)} – ${formatShortYear(b)}`;
}

export function monthLabel(n: number): string {
  if (n < 0) return 'Before birth';
  if (n === 0) return 'Newborn';
  if (n % 12 === 0) return n === 12 ? '1 year' : `${n / 12} years`;
  return `${n} ${n === 1 ? 'month' : 'months'}`;
}

/** Compact age for captions, e.g. "5 mo", "newborn", "1 yr". */
export function ageShort(n: number): string {
  if (n < 0) return 'before birth';
  if (n === 0) return 'newborn';
  if (n % 12 === 0) return `${n / 12} yr`;
  return `${n} mo`;
}

export function formatTime(local: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(local);
  if (!m) return '';
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

/** Local wall-clock string from a JS Date's local fields. */
export function localStringFromDate(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
