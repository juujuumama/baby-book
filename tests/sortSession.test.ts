import { describe, expect, it } from 'vitest';
import { mergeOrder, type Pile } from '../src/lib/sortSession';

const pile = (label: string, ids: string[]): Pile => ({ id: label, label, photoIds: ids, unmatched: 0, createdAt: 0 });

describe('mergeOrder', () => {
  it('interleaves sorted piles by time taken', () => {
    const taken: Record<string, string> = { a: '2025-07-01', b: '2025-07-05', c: '2025-07-03', d: '2025-07-09', e: '2025-07-04' };
    const steps = mergeOrder([pile('A', ['a', 'b', 'd']), pile('B', ['c', 'e'])], (id) => taken[id]);
    expect(steps.map((s) => `${s.pile}:${s.photoId}`)).toEqual(['A:a', 'B:c', 'B:e', 'A:b', 'A:d']);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
  });
});
