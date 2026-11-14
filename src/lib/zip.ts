// Minimal "stored" (uncompressed) ZIP writer and reader. JPEGs don't compress,
// so storing is just as small and lets us build huge archives out of Blob
// slices without holding every photo in memory at once.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const enc = new TextEncoder();
export const ZIP_MAX_BYTES = 0xffffffff - 1024 * 1024; // stay well clear of the non-ZIP64 limit

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

interface Pending { name: Uint8Array<ArrayBuffer>; crc: number; size: number; offset: number }

export class ZipWriter {
  private parts: BlobPart[] = [];
  private entries: Pending[] = [];
  private offset = 0;
  private stamp = dosDateTime(new Date());

  get size() { return this.offset; }

  async add(name: string, data: Blob | string): Promise<void> {
    const blob = typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes);
    const nameBytes = enc.encode(name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, this.stamp.time, true);
    h.setUint16(12, this.stamp.date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.entries.push({ name: nameBytes, crc, size: bytes.length, offset: this.offset });
    // Keep the original Blob (often disk-backed) rather than the bytes we read.
    this.parts.push(h.buffer, nameBytes, blob);
    this.offset += 30 + nameBytes.length + bytes.length;
  }

  finish(): Blob {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, this.stamp.time, true);
      c.setUint16(14, this.stamp.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.name.length, true);
      c.setUint32(42, e.offset, true);
      this.parts.push(c.buffer, e.name);
      cdSize += 46 + e.name.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    this.parts.push(end.buffer);
    return new Blob(this.parts, { type: 'application/zip' });
  }
}

export interface ZipEntry { name: string; blob: Blob }

/** Read a stored-only ZIP lazily; each entry is a slice of the original file. */
export async function readZip(file: Blob): Promise<Map<string, ZipEntry>> {
  const tailLen = Math.min(file.size, 22 + 0xffff);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a Baby Book backup (no ZIP directory found).');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Backup file is damaged.');
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (method !== 0) throw new Error(`Backup entry ${name} is compressed; only Baby Book backups can be restored.`);
    const lh = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    const dataStart = localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.set(name, { name, blob: file.slice(dataStart, dataStart + csize) });
  }
  return out;
}
