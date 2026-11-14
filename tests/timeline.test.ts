import { describe, expect, it } from 'vitest';
import { parseYMD } from '../src/lib/dates';
import { buildTimeline } from '../src/lib/timeline';
import type { Photo } from '../src/lib/types';

let i = 0;
const photo = (taken: string | null, favorite = false): Photo => ({
  id: `p${++i}`, taken, dateSource: taken ? 'exif' : null, fileDate: null, nameDate: null, fileName: 'x.jpg',
  width: 1, height: 1, origWidth: 1, origHeight: 1, camera: null, dedupeKey: `k${i}`, favorite, addedAt: i,
});

describe('buildTimeline', () => {
  it('groups by month of age and day, with undated pile', () => {
    const birth = parseYMD('2025-03-12')!;
    const t = buildTimeline([
      photo('2025-12-25T09:00:00', true),
      photo('2025-03-12T08:00:00'),
      photo('2025-03-20T08:00:00'),
      photo('2025-01-01T08:00:00'),
      photo(null),
      photo('2025-12-25T08:00:00'),
    ], birth);
    expect(t.undated).toHaveLength(1);
    expect(t.months.map((m) => m.month)).toEqual([-1, 0, 9]);
    const nine = t.months[2];
    expect(nine.days).toHaveLength(1);
    expect(nine.days[0].holiday?.name).toBe('Christmas');
    expect(nine.days[0].photos.map((p) => p.taken)).toEqual(['2025-12-25T08:00:00', '2025-12-25T09:00:00']);
    expect(nine.favorites).toBe(1);
    expect(nine.holidays.map((h) => h.holiday.name)).toContain('Christmas Eve');
  });
});
