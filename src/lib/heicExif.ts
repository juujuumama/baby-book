// Pulls the EXIF block out of a HEIC/HEIF file (the iPhone's photo format) by
// walking its box structure: meta → iinf finds the "Exif" item, iloc says
// where its bytes live. Returns the TIFF data that EXIF readers understand.

type View = DataView;

function u(v: View, o: number, size: number): number {
  switch (size) {
    case 0: return 0;
    case 1: return v.getUint8(o);
    case 2: return v.getUint16(o);
    case 4: return v.getUint32(o);
    case 8: return v.getUint32(o) * 2 ** 32 + v.getUint32(o + 4);
    default: throw new Error('bad size');
  }
}

function fourcc(v: View, o: number) {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

interface Box { type: string; start: number; body: number; end: number }

function boxes(v: View, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = fourcc(v, o + 4);
    let body = o + 8;
    if (size === 1) { size = u(v, o + 8, 8); body = o + 16; } else if (size === 0) size = end - o;
    if (size < 8 || o + size > end) break;
    out.push({ type, start: o, body, end: o + size });
    o += size;
  }
  return out;
}

export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (fourcc(v, 4) !== 'ftyp') return false;
  const brand = fourcc(v, 8);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif'].includes(brand);
}

/** The TIFF-format EXIF bytes inside a HEIF file, or null. */
export function heifExifTiff(buf: Uint8Array): Uint8Array | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = boxes(v, 0, buf.byteLength);
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) return null;
  const inner = boxes(v, meta.body + 4, meta.end); // meta is a full box (version + flags)

  // iinf: find the item whose type is 'Exif'.
  const iinf = inner.find((b) => b.type === 'iinf');
  if (!iinf) return null;
  const iinfVer = v.getUint8(iinf.body);
  const entriesStart = iinf.body + 4 + (iinfVer === 0 ? 2 : 4);
  let exifId = -1;
  for (const infe of boxes(v, entriesStart, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const ver = v.getUint8(infe.body);
    if (ver < 2) continue;
    let o = infe.body + 4;
    const id = ver === 2 ? v.getUint16(o) : v.getUint32(o);
    o += ver === 2 ? 2 : 4;
    o += 2; // protection index
    if (fourcc(v, o) === 'Exif') { exifId = id; break; }
  }
  if (exifId < 0) return null;

  // iloc: where that item's bytes are.
  const iloc = inner.find((b) => b.type === 'iloc');
  if (!iloc) return null;
  const ver = v.getUint8(iloc.body);
  let o = iloc.body + 4;
  const a = v.getUint8(o), b = v.getUint8(o + 1);
  o += 2;
  const offSize = a >> 4, lenSize = a & 15, baseSize = b >> 4, idxSize = ver === 1 || ver === 2 ? b & 15 : 0;
  const count = ver < 2 ? v.getUint16(o) : v.getUint32(o);
  o += ver < 2 ? 2 : 4;
  for (let i = 0; i < count; i++) {
    const id = ver < 2 ? v.getUint16(o) : v.getUint32(o);
    o += ver < 2 ? 2 : 4;
    let method = 0;
    if (ver === 1 || ver === 2) { method = v.getUint16(o) & 15; o += 2; }
    o += 2; // data reference index
    const base = u(v, o, baseSize); o += baseSize;
    const extents = v.getUint16(o); o += 2;
    const parts: [number, number][] = [];
    for (let e = 0; e < extents; e++) {
      o += idxSize;
      const off = u(v, o, offSize); o += offSize;
      const len = u(v, o, lenSize); o += lenSize;
      parts.push([off, len]);
    }
    if (id !== exifId) continue;
    let origin = base;
    if (method === 1) {
      const idat = inner.find((x) => x.type === 'idat');
      if (!idat) return null;
      origin += idat.body;
    } else if (method !== 0) return null;
    const total = parts.reduce((s, [, l]) => s + l, 0);
    const data = new Uint8Array(total);
    let w = 0;
    for (const [off, len] of parts) {
      const from = origin + off;
      if (from + len > buf.byteLength) return null;
      data.set(buf.subarray(from, from + len), w);
      w += len;
    }
    // The Exif item starts with a 4-byte offset to the TIFF header.
    if (data.length < 8) return null;
    let start = 4 + new DataView(data.buffer).getUint32(0);
    // Be forgiving: find the TIFF byte-order mark if the offset looks wrong.
    const isTiff = (k: number) => (data[k] === 0x49 && data[k + 1] === 0x49 && data[k + 2] === 0x2a) || (data[k] === 0x4d && data[k + 1] === 0x4d && data[k + 3] === 0x2a);
    if (!isTiff(start)) {
      start = -1;
      for (let k = 0; k < Math.min(64, data.length - 4); k++) if (isTiff(k)) { start = k; break; }
      if (start < 0) return null;
    }
    return data.subarray(start);
  }
  return null;
}
