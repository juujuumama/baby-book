import { describe, expect, it } from 'vitest';
import { crc32, readZip, ZipWriter } from '../src/lib/zip';

describe('zip', () => {
  it('crc32 matches known value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('round-trips entries', async () => {
    const w = new ZipWriter();
    const bytes = new Uint8Array(5000).map((_, i) => i % 251);
    await w.add('photos/a.jpg', new Blob([bytes]));
    await w.add('baby-book.json', JSON.stringify({ hello: 'wörld' }));
    const zip = w.finish();
    const entries = await readZip(zip);
    expect([...entries.keys()]).toEqual(['photos/a.jpg', 'baby-book.json']);
    expect(new Uint8Array(await entries.get('photos/a.jpg')!.blob.arrayBuffer())).toEqual(bytes);
    expect(JSON.parse(await entries.get('baby-book.json')!.blob.text())).toEqual({ hello: 'wörld' });
  });
});
