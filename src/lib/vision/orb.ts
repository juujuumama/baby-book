import { fitSize, resizeRaster, toGray, type Raster } from './raster';

// Feature-point matching (ORB-style): find distinctive corners, describe the
// patch around each with a 256-bit fingerprint, and match fingerprints between
// a print and a photo. A true match has many points that agree on one
// consistent shift/turn/scale; lookalike photos only line up a few. Robust to
// crop, colour shifts, glare on part of the print and slightly-off outlines.

export interface Orb { n: number; x: Float32Array; y: Float32Array; d: Uint32Array; w: number; h: number }

export const ORB_EDGE = 320;
const DEFAULT_POINTS = 400;
const PATCH = 15;

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

// 256 point pairs inside the patch (fixed), pre-rotated into 30 angle steps.
const ANGLES = 30;
const PAIRS: Int8Array[] = (() => {
  const r = rng(12345);
  const gauss = () => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const base: number[] = [];
  for (let i = 0; i < 256; i++) for (let k = 0; k < 2; k++) {
    let x = 0, y = 0;
    do { x = Math.round(gauss() * 5); y = Math.round(gauss() * 5); } while (x * x + y * y > 12 * 12);
    base.push(x, y);
  }
  return Array.from({ length: ANGLES }, (_, a) => {
    const t = (a / ANGLES) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    const out = new Int8Array(base.length);
    for (let i = 0; i < base.length; i += 2) {
      out[i] = Math.round(base[i] * c - base[i + 1] * s);
      out[i + 1] = Math.round(base[i] * s + base[i + 1] * c);
    }
    return out;
  });
})();

const CIRCLE = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];

export function computeOrb(r: Raster, maxPoints = DEFAULT_POINTS): Orb {
  const MAX_POINTS = maxPoints;
  const s = fitSize(r.w, r.h, ORB_EDGE);
  const small = s.scale < 1 ? resizeRaster(r, s.w, s.h) : r;
  const g = toGray(small);
  const { w, h } = g;
  const I = g.data;
  // Locally normalised copy: prints and screens differ in brightness and contrast.
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { sum += I[yy * w + xx]; n++; }
    }
    blur[y * w + x] = sum / n;
  }

  // FAST-9 corners with a simple strength score.
  const T = 14;
  const score = new Float32Array(w * h);
  const off = CIRCLE.map(([dx, dy]) => dy * w + dx);
  const m = PATCH + 2;
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const i = y * w + x, p = I[i];
    // quick test on 4 compass points
    let b = 0, d = 0;
    for (const k of [0, 4, 8, 12]) { const v = I[i + off[k]]; if (v > p + T) b++; else if (v < p - T) d++; }
    if (b < 3 && d < 3) continue;
    let run = 0, best = 0, sumAbs = 0, sign = 0;
    for (let k = 0; k < 32; k++) {
      const v = I[i + off[k & 15]];
      const sg = v > p + T ? 1 : v < p - T ? -1 : 0;
      if (sg !== 0 && sg === sign) run++; else { run = sg !== 0 ? 1 : 0; sign = sg; }
      if (run > best) best = run;
      if (k < 16) sumAbs += Math.abs(v - p);
    }
    if (best >= 9) score[i] = sumAbs;
  }
  // Non-maximum suppression and an even spread across the image (grid cells).
  const cand: [number, number][] = [];
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const i = y * w + x, v = score[i];
    if (!v) continue;
    if (v < score[i - 1] || v < score[i + 1] || v < score[i - w] || v < score[i + w] || v < score[i - w - 1] || v < score[i - w + 1] || v < score[i + w - 1] || v < score[i + w + 1]) continue;
    cand.push([i, v]);
  }
  const G = 8, perCell = Math.ceil((MAX_POINTS * 1.5) / (G * G));
  const cells = new Map<number, [number, number][]>();
  for (const c of cand) {
    const x = c[0] % w, y = (c[0] - x) / w;
    const key = Math.floor((y / h) * G) * G + Math.floor((x / w) * G);
    (cells.get(key) ?? cells.set(key, []).get(key)!).push(c);
  }
  let pts: [number, number][] = [];
  for (const list of cells.values()) pts.push(...list.sort((a, b) => b[1] - a[1]).slice(0, perCell));
  pts = pts.sort((a, b) => b[1] - a[1]).slice(0, MAX_POINTS);

  const n = pts.length;
  const xs = new Float32Array(n), ys = new Float32Array(n), d = new Uint32Array(n * 8);
  pts.forEach(([i], k) => {
    const x = i % w, y = (i - x) / w;
    // Orientation from the patch's intensity centroid.
    let m10 = 0, m01 = 0;
    for (let dy = -PATCH; dy <= PATCH; dy++) for (let dx = -PATCH; dx <= PATCH; dx++) {
      if (dx * dx + dy * dy > PATCH * PATCH) continue;
      const v = I[(y + dy) * w + x + dx];
      m10 += dx * v; m01 += dy * v;
    }
    let a = Math.atan2(m01, m10);
    if (a < 0) a += 2 * Math.PI;
    const pat = PAIRS[Math.round((a / (2 * Math.PI)) * ANGLES) % ANGLES];
    for (let bit = 0; bit < 256; bit++) {
      const j = bit * 4;
      const v1 = blur[(y + pat[j + 1]) * w + x + pat[j]], v2 = blur[(y + pat[j + 3]) * w + x + pat[j + 2]];
      if (v1 < v2) d[k * 8 + (bit >> 5)] |= 1 << (bit & 31);
    }
    xs[k] = x; ys[k] = y;
  });
  return { n, x: xs, y: ys, d, w, h };
}

function popcount(v: number): number {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * How many feature points of `a` (a print) agree with `b` (a photo) under one
 * consistent shift + turn + scale. Higher = more surely the same picture.
 */
export function orbInliers(a: Orb, b: Orb): number {
  if (a.n < 8 || b.n < 8) return 0;
  // Best match for each point of a, kept only if clearly better than the runner-up.
  const mi: number[] = [], mj: number[] = [];
  for (let i = 0; i < a.n; i++) {
    let best = 999, second = 999, bj = -1;
    const ai = i * 8;
    for (let j = 0; j < b.n; j++) {
      const bjj = j * 8;
      let dist = 0;
      for (let k = 0; k < 8 && dist < second; k++) dist += popcount(a.d[ai + k] ^ b.d[bjj + k]);
      if (dist < best) { second = best; best = dist; bj = j; } else if (dist < second) second = dist;
    }
    if (bj >= 0 && best < 70 && best < second * 0.85) { mi.push(i); mj.push(bj); }
  }
  const m = mi.length;
  if (m < 4) return m;
  // RANSAC over similarity transforms (2 point pairs define one).
  const r = rng(m * 7919 + a.n);
  const tol = Math.max(b.w, b.h) * 0.025, tol2 = tol * tol;
  let bestIn = 0;
  for (let it = 0; it < 300; it++) {
    const p = Math.floor(r() * m), q = Math.floor(r() * m);
    if (p === q) continue;
    const ax1 = a.x[mi[p]], ay1 = a.y[mi[p]], ax2 = a.x[mi[q]], ay2 = a.y[mi[q]];
    const bx1 = b.x[mj[p]], by1 = b.y[mj[p]], bx2 = b.x[mj[q]], by2 = b.y[mj[q]];
    const dax = ax2 - ax1, day = ay2 - ay1, dbx = bx2 - bx1, dby = by2 - by1;
    const la = dax * dax + day * day;
    if (la < 100) continue;
    // b = s·R·a + t  →  [c -s; s c] with c = s cosθ, s = s sinθ
    const c = (dax * dbx + day * dby) / la, sn = (dax * dby - day * dbx) / la;
    const scale = Math.hypot(c, sn);
    if (scale < 0.3 || scale > 3.5) continue;
    const tx = bx1 - (c * ax1 - sn * ay1), ty = by1 - (sn * ax1 + c * ay1);
    let inl = 0;
    for (let k = 0; k < m; k++) {
      const x = a.x[mi[k]], y = a.y[mi[k]];
      const ex = c * x - sn * y + tx - b.x[mj[k]], ey = sn * x + c * y + ty - b.y[mj[k]];
      if (ex * ex + ey * ey < tol2) inl++;
    }
    if (inl > bestIn) bestIn = inl;
  }
  return bestIn;
}

/** Photos most likely to contain this print, by voting with exact matches on
 * 16-bit slices of each fingerprint (fast, even across thousands of photos). */
export class OrbIndex {
  private ids: string[] = [];
  private orbs: Orb[] = [];
  private offsets: Uint32Array[] = [];
  private entries: Int32Array[] = []; // photo index per descriptor slice
  constructor(library: Map<string, Orb>) {
    for (const [id, o] of library) { if (o.n) { this.ids.push(id); this.orbs.push(o); } }
    for (let chunk = 0; chunk < 16; chunk++) {
      const counts = new Uint32Array(65537);
      const word = chunk >> 1, shift = (chunk & 1) * 16;
      this.orbs.forEach((o) => { for (let k = 0; k < o.n; k++) counts[((o.d[k * 8 + word] >>> shift) & 0xffff) + 1]++; });
      for (let i = 1; i < 65537; i++) counts[i] += counts[i - 1];
      const fill = counts.slice();
      const entries = new Int32Array(counts[65536]);
      this.orbs.forEach((o, pi) => { for (let k = 0; k < o.n; k++) { const key = (o.d[k * 8 + word] >>> shift) & 0xffff; entries[fill[key]++] = pi; } });
      this.offsets.push(counts);
      this.entries.push(entries);
    }
  }
  get size() { return this.ids.length; }
  shortlist(q: Orb, top: number): string[] {
    const votes = new Float32Array(this.ids.length);
    for (let k = 0; k < q.n; k++) {
      const seen = new Set<number>();
      for (let chunk = 0; chunk < 16; chunk++) {
        const word = chunk >> 1, shift = (chunk & 1) * 16;
        const key = (q.d[k * 8 + word] >>> shift) & 0xffff;
        const off = this.offsets[chunk], ent = this.entries[chunk];
        const end = off[key + 1];
        // Very common slices (flat areas) say little; skip huge buckets.
        if (end - off[key] > 400) continue;
        for (let e = off[key]; e < end; e++) seen.add(ent[e]);
      }
      for (const pi of seen) votes[pi]++;
    }
    // Normalise by how many points each photo has, so busy photos don't always win.
    const order = this.ids.map((_, i) => i).sort((a, b) => votes[b] / Math.sqrt(this.orbs[b].n) - votes[a] / Math.sqrt(this.orbs[a].n));
    return order.slice(0, top).map((i) => this.ids[i]);
  }
}

export interface PackedOrb { n: number; w: number; h: number; xy: Uint16Array; d: Uint32Array }

/** Compact storage form. */
export function packOrb(o: Orb): PackedOrb {
  const xy = new Uint16Array(o.n * 2);
  for (let i = 0; i < o.n; i++) { xy[i * 2] = Math.round(o.x[i]); xy[i * 2 + 1] = Math.round(o.y[i]); }
  return { n: o.n, w: o.w, h: o.h, xy, d: o.d };
}

export function unpackOrb(p: PackedOrb): Orb {
  const x = new Float32Array(p.n), y = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) { x[i] = p.xy[i * 2]; y[i] = p.xy[i * 2 + 1]; }
  return { n: p.n, x, y, d: p.d, w: p.w, h: p.h };
}

function hamming(a: Uint32Array, ai: number, b: Uint32Array, bi: number): number {
  let d = 0;
  for (let k = 0; k < 8; k++) d += popcount(a[ai + k] ^ b[bi + k]);
  return d;
}

/** Binary k-means ("k-majority"): centres are bitwise majorities of their members. */
function kMajority(data: Uint32Array, idx: number[], k: number, iters: number, seed: number): Uint32Array {
  const r = rng(seed);
  const centres = new Uint32Array(k * 8);
  for (let c = 0; c < k; c++) { const s = idx[Math.floor(r() * idx.length)]; centres.set(data.subarray(s * 8, s * 8 + 8), c * 8); }
  const assign = new Int32Array(idx.length);
  for (let it = 0; it < iters; it++) {
    idx.forEach((s, n) => {
      let best = 999, bc = 0;
      for (let c = 0; c < k; c++) { const d = hamming(data, s * 8, centres, c * 8); if (d < best) { best = d; bc = c; } }
      assign[n] = bc;
    });
    const counts = new Int32Array(k * 256), sizes = new Int32Array(k);
    idx.forEach((s, n) => {
      const c = assign[n]; sizes[c]++;
      for (let bit = 0; bit < 256; bit++) if (data[s * 8 + (bit >> 5)] & (1 << (bit & 31))) counts[c * 256 + bit]++;
    });
    for (let c = 0; c < k; c++) {
      if (!sizes[c]) continue;
      const v = new Uint32Array(8);
      for (let bit = 0; bit < 256; bit++) if (counts[c * 256 + bit] * 2 > sizes[c]) v[bit >> 5] |= 1 << (bit & 31);
      centres.set(v, c * 8);
    }
  }
  return centres;
}

/**
 * "Visual words": fingerprints grouped into ~1000 families (a two-level tree),
 * so a print can be compared with thousands of photos by the words they share.
 */
export class OrbVocab {
  readonly top: Uint32Array;
  readonly leaves: Uint32Array[];
  static readonly K1 = 16;
  static readonly K2 = 64;
  constructor(top: Uint32Array, leaves: Uint32Array[]) { this.top = top; this.leaves = leaves; }

  static train(orbs: Orb[], seed = 7): OrbVocab {
    // Pool a sample of fingerprints.
    let total = 0;
    for (const o of orbs) total += o.n;
    const want = Math.min(total, 40000), r = rng(seed);
    const data = new Uint32Array(want * 8);
    let n = 0;
    for (const o of orbs) for (let k = 0; k < o.n && n < want; k++) if (r() < want / total) { data.set(o.d.subarray(k * 8, k * 8 + 8), n * 8); n++; }
    const all = Array.from({ length: n }, (_, i) => i);
    const top = kMajority(data, all, OrbVocab.K1, 6, seed);
    const groups: number[][] = Array.from({ length: OrbVocab.K1 }, () => []);
    for (const i of all) {
      let best = 999, bc = 0;
      for (let c = 0; c < OrbVocab.K1; c++) { const d = hamming(data, i * 8, top, c * 8); if (d < best) { best = d; bc = c; } }
      groups[bc].push(i);
    }
    const leaves = groups.map((g, c) => (g.length >= OrbVocab.K2 ? kMajority(data, g, OrbVocab.K2, 5, seed + c + 1) : kMajority(data, g.length ? g : all, Math.min(OrbVocab.K2, Math.max(1, g.length)), 3, seed + c + 1)));
    return new OrbVocab(top, leaves);
  }

  word(d: Uint32Array, i: number): number {
    let best = 999, bc = 0;
    for (let c = 0; c < OrbVocab.K1; c++) { const h = hamming(d, i * 8, this.top, c * 8); if (h < best) { best = h; bc = c; } }
    const leaf = this.leaves[bc], k2 = leaf.length / 8;
    let best2 = 999, bl = 0;
    for (let c = 0; c < k2; c++) { const h = hamming(d, i * 8, leaf, c * 8); if (h < best2) { best2 = h; bl = c; } }
    return bc * OrbVocab.K2 + bl;
  }

  words(o: Orb): Map<number, number> {
    const m = new Map<number, number>();
    for (let i = 0; i < o.n; i++) { const w = this.word(o.d, i); m.set(w, (m.get(w) ?? 0) + 1); }
    return m;
  }
}

/** Ranks photos for a print by tf-idf similarity of their visual words. */
export class BowIndex {
  private ids: string[] = [];
  private inverted = new Map<number, { p: number; w: number }[]>();
  private idf = new Map<number, number>();
  constructor(private vocab: OrbVocab, library: Map<string, Orb>) {
    const docs: Map<number, number>[] = [];
    for (const [id, o] of library) { if (!o.n) continue; this.ids.push(id); docs.push(vocab.words(o)); }
    const df = new Map<number, number>();
    for (const d of docs) for (const w of d.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    for (const [w, c] of df) this.idf.set(w, Math.log(docs.length / c));
    docs.forEach((d, p) => {
      let norm = 0;
      const ws: [number, number][] = [];
      for (const [w, c] of d) { const v = c * (this.idf.get(w) ?? 0); ws.push([w, v]); norm += v * v; }
      norm = Math.sqrt(norm) || 1;
      for (const [w, v] of ws) (this.inverted.get(w) ?? this.inverted.set(w, []).get(w)!).push({ p, w: v / norm });
    });
  }
  get size() { return this.ids.length; }
  shortlist(q: Orb, top: number): string[] {
    const qw = this.vocab.words(q);
    const scores = new Float32Array(this.ids.length);
    let norm = 0;
    const qv: [number, number][] = [];
    for (const [w, c] of qw) { const v = c * (this.idf.get(w) ?? 0); qv.push([w, v]); norm += v * v; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, v] of qv) for (const e of this.inverted.get(w) ?? []) scores[e.p] += (v / norm) * e.w;
    return this.ids.map((_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, top).map((i) => this.ids[i]);
  }
}
