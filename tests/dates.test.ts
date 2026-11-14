import { describe, expect, it } from 'vitest';
import { addMonths, ageInMonths, monthRange, monthLabel, parseYMD } from '../src/lib/dates';
import { easter, holidayOn } from '../src/lib/holidays';
import { dateFromName } from '../src/lib/exif';

const d = (s: string) => parseYMD(s)!;

describe('ageInMonths', () => {
  const birth = d('2025-01-31');
  it('counts completed calendar months', () => {
    expect(ageInMonths(birth, d('2025-01-31'))).toBe(0);
    expect(ageInMonths(birth, d('2025-02-27'))).toBe(0);
    expect(ageInMonths(birth, d('2025-02-28'))).toBe(1); // clamped month-birthday
    expect(ageInMonths(birth, d('2025-03-30'))).toBe(1);
    expect(ageInMonths(birth, d('2025-03-31'))).toBe(2);
    expect(ageInMonths(birth, d('2026-01-31'))).toBe(12);
  });
  it('is negative before birth', () => {
    expect(ageInMonths(birth, d('2025-01-30'))).toBe(-1);
    expect(ageInMonths(birth, d('2024-11-15'))).toBe(-3);
  });
  it('month ranges tile without gaps', () => {
    const b = d('2025-03-12');
    for (let n = 0; n < 24; n++) {
      const r = monthRange(b, n);
      const next = monthRange(b, n + 1);
      expect(ageInMonths(b, r.start)).toBe(n);
      expect(ageInMonths(b, r.end)).toBe(n);
      expect(next.start).toEqual(addMonths(b, n + 1));
    }
  });
  it('labels', () => {
    expect(monthLabel(0)).toBe('Newborn');
    expect(monthLabel(1)).toBe('1 month');
    expect(monthLabel(12)).toBe('1 year');
  });
});

describe('holidays', () => {
  it('computes Easter', () => {
    expect(easter(2025)).toEqual(d('2025-04-20'));
    expect(easter(2026)).toEqual(d('2026-04-05'));
  });
  it('finds floating and fixed holidays', () => {
    expect(holidayOn(d('2025-11-27'))?.name).toBe('Thanksgiving');
    expect(holidayOn(d('2025-05-11'))?.name).toBe("Mother's Day");
    expect(holidayOn(d('2025-05-26'))?.name).toBe('Memorial Day');
    expect(holidayOn(d('2025-12-25'))?.name).toBe('Christmas');
    expect(holidayOn(d('2025-12-26'))).toBeNull();
  });
  it('marks birthdays', () => {
    expect(holidayOn(d('2026-03-12'), d('2025-03-12'))?.name).toBe('First birthday');
  });
});

describe('dateFromName', () => {
  it('reads common patterns', () => {
    expect(dateFromName('IMG_20250612_140301.jpg')).toBe('2025-06-12T14:03:01');
    expect(dateFromName('Screenshot 2025-06-12 at 14.03.01.png')).toBe('2025-06-12T14:03:01');
    expect(dateFromName('PXL_20250102.jpg')).toBe('2025-01-02T12:00:00');
    expect(dateFromName('IMG_1234.HEIC')).toBeNull();
  });
});
