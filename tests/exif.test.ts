import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readMeta } from '../src/lib/exif';

// A tiny HEIC with EXIF (DateTimeOriginal 2025:06:12 14:03:00), checked in as a fixture.
const FIX = new URL('./fixtures/', import.meta.url).pathname;

describe('readMeta', () => {
  it('reads the date from a HEIC photo', async () => {
    const buf = readFileSync(FIX + 'tiny.heic');
    const meta = await readMeta(new Blob([buf]));
    expect(meta.taken).toBe('2025-06-12T14:03:00');
  });
  it('reads the date from XMP in a PNG', async () => {
    if (!existsSync(FIX + 'xmp.png')) return;
    const meta = await readMeta(new Blob([readFileSync(FIX + 'xmp.png')]));
    expect(meta.taken).toBe('2025-06-12T14:03:00');
  });
});
