import type { Raster } from './raster';
import type { Pt, Quad } from './warp';

// Finds photo prints lying on a table or floor.
//
// 1. Learn what the background looks like from the image border (prints
//    rarely touch the edge of the shot), as a few colour clusters.
// 2. Mark every pixel that looks unlike the background.
// 3. Clean that mask up (close gaps, fill holes, cut thin bridges between
//    prints that nearly touch), then split it into connected blobs.
// 4. Fit the largest four-sided shape inside each blob's outline. Blobs that
//    a quadrilateral fills well are prints; others are flagged (usually
//    overlapping prints).

export interface Detection {
  quad: Quad;
  /** How well the quad matches the blob (1 = perfect rectangle). */
  fill: number;
  area: number;
  /** True when this probably isn't a single clean print (overlapping, cut off). */
  doubtful: boolean;
  touchesEdge: boolean;
}

export interface DetectOptions {
  /** Smallest print, as a fraction of the image area. */
  minArea?: number;
}

function ycc(d: Uint8ClampedArray, i: number): [number, number, number] {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  return [0.299 * r + 0.587 * g + 0.114 * b, -0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
}

function boxBlur(r: Raster, radius: number): Raster {
  const { w, h } = r;
  const tmp = new Float32Array(w * h * 3), out = new Uint8ClampedArray(w * h * 4);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let x = -radius; x <= radius; x++) s += r.data[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = s / n;
        const add = Math.min(w - 1, x + radius + 1), sub = Math.max(0, x - radius);
        s += r.data[(y * w + add) * 4 + c] - r.data[(y * w + sub) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let y = -radius; y <= radius; y++) s += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = s / n;
        const add = Math.min(h - 1, y + radius + 1), sub = Math.max(0, y - radius);
        s += tmp[(add * w + x) * 3 + c] - tmp[(sub * w + x) * 3 + c];
      }
    }
    for (let y = 0; y < h; y++) out[(y * w + x) * 4 + 3] = 255;
  }
  return { w, h, data: out };
}

/** k-means on border pixels: a small palette describing the background. */
function backgroundPalette(r: Raster, k = 8, share = 0.05): [number, number, number][] {
  const { w, h, data } = r;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const samples: [number, number, number][] = [];
  const step = Math.max(1, Math.round((w + h) / 600));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (x >= band && x < w - band && y >= band && y < h - band) continue;
    samples.push(ycc(data, (y * w + x) * 4));
  }
  let centers = samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / k)) === 0).slice(0, k);
  for (let it = 0; it < 8; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      const t = sums[best]; t[0] += s[0]; t[1] += s[1]; t[2] += s[2]; t[3]++;
    }
    const kept = sums.filter((t) => t[3] > samples.length * 0.03);
    centers = kept.map((t) => [t[0] / t[3], t[1] / t[3], t[2] / t[3]]);
    if (!centers.length) centers = [samples[0]];
    if (it === 7) {
      // Prints that reach the edge of the shot show up on the border too; keep
      // only colours that cover a good share of it (the table itself).
      const big = kept.map((t, i) => [t[3], i] as const).filter(([n]) => n > samples.length * share);
      if (big.length) {
        // The edge of the photo can also catch other things (cabinets, a rug,
        // a dark baseboard). Keep the main floor colour and shades near it.
        const [, mainI] = big.reduce((a, b) => (b[0] > a[0] ? b : a));
        const main = centers[mainI];
        const near = (c: number[]) => Math.sqrt((c[0] - main[0]) ** 2 + 2.5 * ((c[1] - main[1]) ** 2 + (c[2] - main[2]) ** 2)) < 75;
        centers = big.map(([, i]) => centers[i]).filter(near);
      }
    }
  }
  return centers;
}

function otsu(values: Float32Array, max: number): number {
  const bins = 256, hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.floor((v / max) * bins))]++;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = values.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; bestT = i; }
  }
  return ((bestT + 0.5) / bins) * max;
}

/** Binary morphology with a square element, via running counts. */
function morph(mask: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const full = 2 * r + 1;
  const test = (count: number, n: number) => (dilate ? count > 0 : count === n);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) c += mask[row + x]; else if (!dilate) c += 1; // outside counts as set for erosion
    for (let x = 0; x < w; x++) {
      tmp[row + x] = test(c, full) ? 1 : 0;
      const add = x + r + 1, sub = x - r;
      c += (add < w ? mask[row + add] : dilate ? 0 : 1) - (sub >= 0 ? mask[row + sub] : dilate ? 0 : 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) c += tmp[y * w + x]; else if (!dilate) c += 1;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = test(c, full) ? 1 : 0;
      const add = y + r + 1, sub = y - r;
      c += (add < h ? tmp[add * w + x] : dilate ? 0 : 1) - (sub >= 0 ? tmp[sub * w + x] : dilate ? 0 : 1);
    }
  }
  return out;
}

/** Fill enclosed holes: anything background not reachable from the border becomes foreground. */
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] || !seen[i] ? 1 : 0;
  return out;
}

interface Blob { area: number; pts: Pt[]; touchesEdge: boolean; pixels: Int32Array }

function components(mask: Uint8Array, w: number, h: number, minArea: number): Blob[] {
  const label = new Int32Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = next++;
    label[start] = id;
    stack.push(start);
    let area = 0, edge = false;
    const pix: number[] = [];
    const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1);
    let y0 = h, y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      area++;
      pix.push(i);
      if (x < minX[y]) minX[y] = x;
      if (x > maxX[y]) maxX[y] = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = id; stack.push(i + w); }
    }
    if (area < minArea) continue;
    const pts: Pt[] = [];
    for (let y = y0; y <= y1; y++) {
      if (maxX[y] < 0) continue;
      pts.push({ x: minX[y], y }, { x: maxX[y] + 1, y }, { x: minX[y], y: y + 1 }, { x: maxX[y] + 1, y: y + 1 });
    }
    blobs.push({ area, pts, touchesEdge: edge, pixels: Int32Array.from(pix) });
  }
  return blobs;
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (monotone chain), returned clockwise in image coordinates (y down). */
export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise in math coords = clockwise on screen
}

export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a) / 2;
}

const tri = (a: Pt, b: Pt, c: Pt) => Math.abs(cross(a, b, c)) / 2;

/** Largest-area quadrilateral with corners on a convex polygon. */
export function maxAreaQuad(hull: Pt[]): Quad | null {
  const n = hull.length;
  if (n < 4) return null;
  const P = (i: number) => hull[((i % n) + n) % n];
  let best = -1, res: [number, number, number, number] = [0, 1, 2, 3];
  for (let i = 0; i < n; i++) {
    let j = i + 1, l = i + 3;
    for (let k = i + 2; k < i + n - 1; k++) {
      if (j <= i || j >= k) j = i + 1;
      while (j + 1 < k && tri(P(i), P(j + 1), P(k)) >= tri(P(i), P(j), P(k))) j++;
      if (l <= k) l = k + 1;
      while (l + 1 < i + n && tri(P(k), P(l + 1), P(i)) >= tri(P(k), P(l), P(i))) l++;
      const a = tri(P(i), P(j), P(k)) + tri(P(k), P(l), P(i));
      if (a > best) { best = a; res = [i, j, k, l]; }
    }
  }
  return res.map((i) => P(i)) as Quad;
}

/** Smallest rectangle (any rotation) enclosing a convex polygon: rotating calipers. */
export function minAreaRect(hull: Pt[]): Quad | null {
  const n = hull.length;
  if (n < 3) return null;
  let best = Infinity, res: Quad | null = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-9) continue;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = (p.x - a.x) * ux + (p.y - a.y) * uy, v = -(p.x - a.x) * uy + (p.y - a.y) * ux;
      if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best) {
      best = area;
      const P = (u: number, v: number): Pt => ({ x: a.x + u * ux - v * uy, y: a.y + u * uy + v * ux });
      res = [P(minU, minV), P(maxU, minV), P(maxU, maxV), P(minU, maxV)];
    }
  }
  return res;
}

/** Orient a quad clockwise on screen, starting from the corner nearest the top-left. */
export function normalizeQuad(q: Quad): Quad {
  const c = { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 };
  const sorted = [...q].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  let start = 0, bestS = Infinity;
  sorted.forEach((p, i) => { if (p.x + p.y < bestS) { bestS = p.x + p.y; start = i; } });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]) as Quad;
}

function cornerAnglesOk(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    if (Math.abs(cos) > 0.5) return false; // corner outside 60°–120°
  }
  return true;
}

/** Colour gradient: per pixel, the channel that changes most (photos meeting edge to edge often differ in colour more than brightness). */
function colorSobel(r: Raster): { gx: Float32Array; gy: Float32Array } {
  const { w, h, data } = r;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let bx = 0, by = 0, bm = -1;
    for (let c = 0; c < 3; c++) {
      const p = (k: number) => data[k * 4 + c];
      const sx = (p(i - w + 1) + 2 * p(i + 1) + p(i + w + 1)) - (p(i - w - 1) + 2 * p(i - 1) + p(i + w - 1));
      const sy = (p(i + w - 1) + 2 * p(i + w) + p(i + w + 1)) - (p(i - w - 1) + 2 * p(i - w) + p(i - w + 1));
      const mm = sx * sx + sy * sy;
      if (mm > bm) { bm = mm; bx = sx; by = sy; }
    }
    gx[i] = bx; gy[i] = by;
  }
  return { gx, gy };
}

function boxMean(v: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += v[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += v[y * w + Math.min(w - 1, x + r + 1)] - v[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function sobel(r: Raster): { gx: Float32Array; gy: Float32Array } {
  const { w, h, data } = r;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
    gy[i] = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
  }
  return { gx, gy };
}

interface Line { p: Pt; d: Pt } // point + unit direction

function intersect(a: Line, b: Line): Pt | null {
  const den = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

/**
 * Nudge each side of a quad onto the print's real border: the straight line
 * with the strongest edge that has table (background) just outside it.
 * Rescues prints whose dark corners blended into a dark table.
 */
function refineQuad(q: Quad, w: number, h: number, grad: { gx: Float32Array; gy: Float32Array }, bg: (x: number, y: number) => boolean): Quad {
  const c = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
  const len = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const lines: Line[] = [];
  for (let e = 0; e < 4; e++) {
    const a = q[e], b = q[(e + 1) % 4];
    const L = len(a, b) || 1;
    const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    let n = { x: -d.y, y: d.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((mid.x - c.x) * n.x + (mid.y - c.y) * n.y < 0) n = { x: -n.x, y: -n.y };
    const perp = (len(q[(e + 1) % 4], q[(e + 2) % 4]) + len(q[(e + 3) % 4], q[e])) / 2;
    const out = Math.max(3, perp * 0.06), inn = Math.max(3, perp * 0.1);
    const step = Math.max(1, Math.round(out / 40));
    const SAMPLES = 32;
    let best = -1, bestA = 0, bestB = 0;
    const score = (oa: number, ob: number) => {
      let gsum = 0, outside = 0, inside = 0, n2 = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const t = 0.08 + 0.84 * (k + 0.5) / SAMPLES;
        const o = oa + (ob - oa) * t;
        const x = a.x + (b.x - a.x) * t + n.x * o, y = a.y + (b.y - a.y) * t + n.y * o;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
        const i = yi * w + xi;
        gsum += Math.abs(grad.gx[i] * n.x + grad.gy[i] * n.y);
        const ox = Math.round(x + n.x * 3), oy = Math.round(y + n.y * 3);
        if (ox >= 0 && oy >= 0 && ox < w && oy < h && bg(ox, oy)) outside++;
        const ix = Math.round(x - n.x * 3), iy = Math.round(y - n.y * 3);
        if (ix >= 0 && iy >= 0 && ix < w && iy < h && bg(ix, iy)) inside++;
        n2++;
      }
      if (n2 < SAMPLES / 2) return -1;
      // A print's border has table outside and print inside; wood grain has table on both sides.
      return (gsum / n2) * (0.1 + Math.max(0, (outside - inside) / n2));
    };
    const base = score(0, 0);
    for (let oa = -inn; oa <= out; oa += step) for (let ob = -inn; ob <= out; ob += step) {
      const sc = score(oa, ob);
      if (sc > best) { best = sc; bestA = oa; bestB = ob; }
    }
    // Only move when the new line is clearly a better border.
    if (best < base * 1.15) { bestA = 0; bestB = 0; best = base; }
    best = score(bestA, bestB);
    // Polish at single-pixel steps.
    for (let oa = bestA - step; oa <= bestA + step; oa += 0.5) for (let ob = bestB - step; ob <= bestB + step; ob += 0.5) {
      const s = score(oa, ob);
      if (s > best) { best = s; bestA = oa; bestB = ob; }
    }
    const pa = { x: a.x + n.x * bestA, y: a.y + n.y * bestA }, pb = { x: b.x + n.x * bestB, y: b.y + n.y * bestB };
    const L2 = len(pa, pb) || 1;
    lines.push({ p: pa, d: { x: (pb.x - pa.x) / L2, y: (pb.y - pa.y) / L2 } });
  }
  const pts: Pt[] = [];
  for (let e = 0; e < 4; e++) {
    const p = intersect(lines[(e + 3) % 4], lines[e]);
    if (!p) return q;
    pts.push(p);
  }
  // Sanity: refinement should only grow or slightly shrink the quad.
  const a0 = polygonArea(q), a1 = polygonArea(pts);
  return a1 > a0 * 0.7 && a1 < a0 * 1.3 ? (pts as Quad) : q;
}

/**
 * Split prints that touch along thin bridges: shrink the mask until they come
 * apart, label each piece, then grow every piece back over the original mask
 * (each pixel goes to the nearest piece).
 */
function separate(mask: Uint8Array, w: number, h: number, r: number, minArea: number): Blob[] {
  const seedsMask = morph(mask, w, h, r, false);
  const seeds = components(seedsMask, w, h, Math.max(16, minArea * 0.15));
  const label = new Int32Array(w * h);
  let queue: number[] = [];
  seeds.forEach((b, k) => { for (const i of b.pixels) { label[i] = k + 1; queue.push(i); } });
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const x = i % w, l = label[i];
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
      for (const j of nb) if (j >= 0 && mask[j] && !label[j]) { label[j] = l; next.push(j); }
    }
    queue = next;
  }
  const out: Blob[] = [];
  const groups: number[][] = seeds.map(() => []);
  for (let i = 0; i < label.length; i++) if (label[i]) groups[label[i] - 1].push(i);
  for (const g of groups) {
    if (g.length < minArea) continue;
    const rows = new Map<number, [number, number]>();
    let edge = false;
    for (const i of g) {
      const x = i % w, y = (i - x) / w;
      const rr = rows.get(y);
      if (!rr) rows.set(y, [x, x]); else { if (x < rr[0]) rr[0] = x; if (x > rr[1]) rr[1] = x; }
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
    }
    const pts: Pt[] = [];
    for (const [y, [a, b]] of rows) pts.push({ x: a, y }, { x: b + 1, y }, { x: a, y: y + 1 }, { x: b + 1, y: y + 1 });
    out.push({ area: g.length, pts, touchesEdge: edge, pixels: Int32Array.from(g) });
  }
  return out;
}

interface Fit { rough: Quad; hull: Pt[]; fill: number; hullFill: number; good: boolean }

function fitBlob(b: Blob): Fit | null {
  const hull = convexHull(b.pts);
  // The enclosing rectangle shrugs off bites out of a print's edges and corners.
  const quad = minAreaRect(hull);
  if (!quad) return null;
  const rough = normalizeQuad(quad);
  const ra = polygonArea(rough);
  const fill = Math.min(b.area / ra, ra / b.area);
  const hullFill = polygonArea(hull) / ra;
  const e = [0, 1, 2, 3].map((i) => Math.hypot(rough[i].x - rough[(i + 1) % 4].x, rough[i].y - rough[(i + 1) % 4].y));
  const aspect = Math.max(e[0] + e[2], e[1] + e[3]) / Math.max(1e-6, Math.min(e[0] + e[2], e[1] + e[3]));
  const good = fill >= 0.82 && hullFill >= 0.9 && aspect < 2.1;
  return { rough, hull, fill, hullFill, good };
}

/**
 * Prints that touch or overlap merge into one blob. A batch is usually all one
 * print size (learned from the prints lying on their own, and scaled for how
 * far each spot is from the camera). Every print-sized rectangle that fits in
 * the blob is scored by how well its four sides sit on real edges (one photo
 * ending and the next beginning, or print meeting floor); the best
 * non-overlapping set wins.
 */
function packCluster(
  b: Blob, w: number, h: number, L: number, S: number,
  scaleAt: (p: { x: number; y: number }) => number, maxPrints: number,
  grad: { gx: Float32Array; gy: Float32Array }, gNorm: number,
): Quad[] {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const i of b.pixels) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const m = new Uint8Array(bw * bh);
  for (const i of b.pixels) { const x = i % w, y = (i - x) / w; m[(y - y0) * bw + (x - x0)] = 1; }
  const inMask = (x: number, y: number) => { const xi = Math.round(x) - x0, yi = Math.round(y) - y0; return xi >= 0 && yi >= 0 && xi < bw && yi < bh ? m[yi * bw + xi] : 0; };
  const edgeAt = (x: number, y: number, nx: number, ny: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return 0;
    const i = yi * w + xi;
    return Math.abs(grad.gx[i] * nx + grad.gy[i] * ny);
  };

  // Angles: the cluster's own rectangle plus its long straight sides.
  const hull = convexHull(b.pts);
  const angles: number[] = [];
  const addAngle = (a: number) => {
    a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    if (!angles.some((t) => Math.min(Math.abs(t - a), Math.PI / 2 - Math.abs(t - a)) < 0.035)) angles.push(a);
  };
  const r0 = minAreaRect(hull);
  if (r0) addAngle(Math.atan2(r0[1].y - r0[0].y, r0[1].x - r0[0].x));
  hull.map((p, i) => { const q = hull[(i + 1) % hull.length]; return { a: Math.atan2(q.y - p.y, q.x - p.x), len: Math.hypot(q.x - p.x, q.y - p.y) }; })
    .filter((e) => e.len > S * 0.8).sort((a, c) => c.len - a.len).forEach((e) => { if (angles.length < 3) addAngle(e.a); });

  type Place = { cx: number; cy: number; a: number; lw: number; lh: number; score: number };
  const IN = 8, JN = 6, PER = 12; // samples per side
  const evaluate = (cx: number, cy: number, a: number, lw: number, lh: number): Place | null => {
    const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
    const P = (u: number, v: number) => [cx + ux * u + vx * v, cy + uy * u + vy * v] as const;
    // Mostly over the cluster (pale parts of a print can drop out of the mask,
    // so this is a loose check; the edges decide).
    let corners = 0;
    for (const [su, sv] of [[-0.4, -0.4], [0.4, -0.4], [0.4, 0.4], [-0.4, 0.4]]) { const [x, y] = P(su * lw, sv * lh); if (inMask(x, y)) corners++; }
    if (corners < 2) return null;
    let inside = 0;
    for (let j = 0; j < JN; j++) for (let i = 0; i < IN; i++) {
      const [x, y] = P(((i + 0.5) / IN - 0.5) * lw * 0.9, ((j + 0.5) / JN - 0.5) * lh * 0.9);
      if (inMask(x, y)) inside++;
    }
    if (inside < IN * JN * 0.6) return null;
    // Edge support, side by side: what fraction of each side sits on a real
    // edge (checking the line and a pixel or two either side). All four sides
    // must be supported, so they're combined with a geometric mean: a box
    // shifted half a print along has two sides in mid-photo and scores low.
    const sides: [number, number, number, number, number, number][] = [
      // start (u, v), along (du, dv), outward normal (nu, nv)
      [-lw / 2, -lh / 2, lw, 0, 0, -1], [lw / 2, -lh / 2, 0, lh, 1, 0], [lw / 2, lh / 2, -lw, 0, 0, 1], [-lw / 2, lh / 2, 0, -lh, -1, 0],
    ];
    let logSum = 0, outside = 0, n = 0;
    for (const [u0, v0, du, dv, nu, nv] of sides) {
      const nx = ux * nu + vx * nv, ny = uy * nu + vy * nv;
      let hits = 0;
      for (let k = 0; k < PER; k++) {
        const t = (k + 0.5) / PER;
        const [x, y] = P(u0 + du * t, v0 + dv * t);
        let e = 0;
        for (const o of [-2, -1, 0, 1, 2]) e = Math.max(e, edgeAt(x + nx * o, y + ny * o, nx, ny));
        hits += Math.min(1, e / gNorm);
        if (!inMask(x + nx * 4, y + ny * 4)) outside++;
        n++;
      }
      logSum += Math.log(0.05 + hits / PER);
    }
    const fillFrac = inside / (IN * JN);
    return { cx, cy, a, lw, lh, score: Math.exp(logSum / 4) + 0.35 * outside / n + 0.8 * fillFrac };
  };

  // Score every placement once.
  const cands: Place[] = [];
  for (const a of angles) {
    for (let cy = y0; cy <= y1; ) {
      const k0 = scaleAt({ x: (x0 + x1) / 2, y: cy });
      const step = Math.max(2, Math.round((S * k0) / 14));
      for (let cx = x0; cx <= x1; cx += step) {
        const k = scaleAt({ x: cx, y: cy });
        // The size estimate can be off when few prints lie on their own, so try a few.
        for (const f of [0.88, 1, 1.12]) for (const [lw, lh] of [[L * k * f, S * k * f], [S * k * f, L * k * f]]) {
          const pl = evaluate(cx, cy, a, lw, lh);
          if (pl) cands.push(pl);
        }
      }
      cy += step;
    }
  }
  cands.sort((p, q) => q.score - p.score);

  // Greedily keep the best placements that don't overlap ones already kept.
  const kept: Place[] = [];
  const overlaps = (p: Place, q: Place) => {
    // Cheap test: centre distance compared with the sizes along both axes.
    const ux = Math.cos(q.a), uy = Math.sin(q.a);
    const dx = p.cx - q.cx, dy = p.cy - q.cy;
    const du = Math.abs(dx * ux + dy * uy), dv = Math.abs(-dx * uy + dy * ux);
    return du < (p.lw + q.lw) / 2 * 0.85 && dv < (p.lh + q.lh) / 2 * 0.85;
  };
  const best = cands[0]?.score ?? 0;
  for (const c of cands) {
    if (kept.length >= maxPrints || c.score < best * 0.6) break;
    if (kept.some((k) => overlaps(c, k))) continue;
    // Polish: small shifts, turns and size changes.
    let p = c;
    for (const dx of [-2, -1, 0, 1, 2]) for (const dy of [-2, -1, 0, 1, 2]) for (const da of [-0.025, 0, 0.025]) for (const sc of [0.96, 1, 1.04]) {
      const q = evaluate(c.cx + dx, c.cy + dy, c.a + da, c.lw * sc, c.lh * sc);
      if (q && q.score > p.score) p = q;
    }
    if (kept.some((k) => overlaps(p, k))) continue;
    kept.push(p);
  }
  return kept.map(({ cx, cy, a, lw, lh }) => {
    const ux = Math.cos(a), uy = Math.sin(a);
    const corner = (u: number, v: number): Pt => ({ x: cx + ux * u - uy * v, y: cy + uy * u + ux * v });
    return normalizeQuad([corner(-lw / 2, -lh / 2), corner(lw / 2, -lh / 2), corner(lw / 2, lh / 2), corner(-lw / 2, lh / 2)]);
  });
}

export function detectPrints(input: Raster, opts: DetectOptions = {}): Detection[] {
  const { w, h } = input;
  const img = boxBlur(input, Math.max(1, Math.round(Math.max(w, h) / 400)));
  const palette = backgroundPalette(img);

  const dist = new Float32Array(w * h);
  let maxD = 1;
  for (let i = 0, p = 0; p < dist.length; i += 4, p++) {
    const [Y, cb, cr] = ycc(img.data, i);
    let best = Infinity;
    for (const c of palette) {
      const d = (Y - c[0]) ** 2 + 2.5 * ((cb - c[1]) ** 2 + (cr - c[2]) ** 2);
      if (d < best) best = d;
    }
    dist[p] = Math.sqrt(best);
    if (dist[p] > maxD) maxD = dist[p];
  }
  // Threshold: just above how much the table itself varies (measured on the
  // border), capped by an Otsu split so busy tables don't swallow everything.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const border: number[] = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x < band || x >= w - band || y < band || y >= h - band) border.push(dist[y * w + x]);
  }
  border.sort((a, b) => a - b);
  // Use a middle percentile: prints reaching the edge of the shot shouldn't
  // count as table texture.
  const noise = border[Math.floor(border.length * 0.8)] ?? 0;
  const t = Math.max(14, Math.min(noise * 2 + 6, otsu(dist, maxD)));
  let mask: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = dist[i] > t ? 1 : 0;

  // Detail: photos are full of fine detail (faces, fabric, toys), floors are
  // smooth. Where a print's colours blend into a light floor, detail still
  // gives it away. Measured as local average gradient, compared with the
  // floor's own (from the border).
  const grad = sobel(img);
  {
    const mag = new Float32Array(w * h);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.abs(grad.gx[i]) + Math.abs(grad.gy[i]);
    const rd = Math.max(2, Math.round(Math.max(w, h) / 350));
    const det = boxMean(mag, w, h, rd);
    const bd: number[] = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      if (x < band || x >= w - band || y < band || y >= h - band) bd.push(det[y * w + x]);
    }
    bd.sort((a, b) => a - b);
    const dT = Math.max(30, (bd[Math.floor(bd.length * 0.5)] ?? 0) * 3);
    // The averaging window spills past each print's edge; shrink it back so
    // the narrow gaps between prints stay open.
    let detMask: Uint8Array = new Uint8Array(w * h);
    for (let i = 0; i < detMask.length; i++) detMask[i] = det[i] > dT ? 1 : 0;
    detMask = morph(detMask, w, h, rd + 2, false);
    for (let i = 0; i < mask.length; i++) mask[i] |= detMask[i];
  }

  const unit = Math.max(1, Math.round(Math.max(w, h) / 500));
  // No gap closing: prints laid close together are separated by only a few
  // pixels of floor, and closing would weld them into one blob.
  mask = fillHoles(mask, w, h);
  mask = morph(morph(mask, w, h, unit, false), w, h, unit, true); // drop specks and hairlines

  const minArea = (opts.minArea ?? 0.004) * w * h;
  const bgT = t * 0.75;
  const isBg = (x: number, y: number) => dist[y * w + x] < bgT;
  const out: Detection[] = [];
  const blobs = separate(mask, w, h, unit * 3, minArea);
  const fits = blobs.map(fitBlob);
  // Typical print size, from blobs that are clearly single prints. Prints laid
  // edge to edge can fuse into neat rectangles of two, so start from a low
  // percentile. When the phone is held at an angle, prints nearer the camera
  // look bigger, so size is modelled as varying across the photo.
  const centre = (b: Blob) => {
    let sx = 0, sy = 0;
    for (const i of b.pixels) { sx += i % w; sy += Math.floor(i / w); }
    return { x: sx / b.pixels.length, y: sy / b.pixels.length };
  };
  const centres = blobs.map(centre);
  const goodIdx = blobs.map((_, i) => i).filter((i) => fits[i]?.good && !blobs[i].touchesEdge);
  const goodAreas = goodIdx.map((i) => blobs[i].area).sort((a, b) => a - b);
  const rough0 = goodAreas.length ? goodAreas[Math.floor(goodAreas.length * 0.3)] : 0;
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  // scale(x, y): how big a print looks at that spot, relative to the median.
  let coef = [1, 0, 0];
  const scaleAt = (p: { x: number; y: number }) => Math.min(1.8, Math.max(0.55, coef[0] + coef[1] * (p.x / w - 0.5) + coef[2] * (p.y / h - 0.5)));
  let singles = goodIdx.filter((i) => blobs[i].area > rough0 * 0.7 && blobs[i].area < rough0 * 1.45);
  let typical = singles.length ? med(singles.map((i) => blobs[i].area)) : 0;
  for (let pass = 0; pass < 2 && singles.length >= 6; pass++) {
    // Least squares: sqrt(area / typical) ~ a + b·x + c·y.
    const rows = singles.map((i) => [1, centres[i].x / w - 0.5, centres[i].y / h - 0.5, Math.sqrt(blobs[i].area / typical)]);
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
    for (const r of rows) for (let a = 0; a < 3; a++) { B[a] += r[a] * r[3]; for (let c = 0; c < 3; c++) A[a][c] += r[a] * r[c]; }
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-9) break;
    coef = [0, 1, 2].map((k) => det(A.map((row, r) => row.map((v, c) => (c === k ? B[r] : v)))) / D);
    singles = goodIdx.filter((i) => { const loc = typical * scaleAt(centres[i]) ** 2; return blobs[i].area > loc * 0.7 && blobs[i].area < loc * 1.45; });
  }
  const localTypical = (i: number) => typical * scaleAt(centres[i]) ** 2;
  // Typical print shape (at scale 1), for unpacking clusters of touching prints.
  const sides = singles.map((i) => {
    const q = fits[i]!.rough, e0 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), e1 = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
    const k = scaleAt(centres[i]);
    return [Math.max(e0, e1) / k, Math.min(e0, e1) / k];
  });
  const L = sides.length ? med(sides.map((s2) => s2[0])) : 0, S = sides.length ? med(sides.map((s2) => s2[1])) : 0;

  let cgrad: { gx: Float32Array; gy: Float32Array } | null = null;
  // A strong edge, for scoring how well a rectangle's sides sit on real borders.
  const gNorm = 160;
  blobs.forEach((b, i) => {
    const f = fits[i];
    if (!f) return;
    const loc = typical > 0 ? localTypical(i) : 0;
    const big = loc > 0 && b.area > loc * 1.15;
    const oversized = loc > 0 && b.area > loc * 1.6;
    if ((!f.good && big || oversized) && L > 0) {
      const quads = packCluster(b, w, h, L, S, scaleAt, Math.max(1, Math.ceil((b.area / loc) * 1.15)), cgrad ??= colorSobel(img), gNorm);
      if (quads.length >= 1) {
        // Cluster pieces keep their packed outline: snapping would reach into the neighbour.
        for (const q of quads) out.push({ quad: q, fill: 1, area: polygonArea(q), doubtful: false, touchesEdge: false });
        return;
      }
    }
    const q = normalizeQuad(refineQuad(f.rough, w, h, grad, isBg));
    const qa = polygonArea(q);
    const doubtful = !f.good || !cornerAnglesOk(q) || b.touchesEdge || (loc > 0 && (qa > loc * 1.8 || qa < loc * 0.4));
    out.push({ quad: q, fill: f.fill, area: qa, doubtful, touchesEdge: b.touchesEdge });
  });
  // Anything reaching the edge of the photo may be cut off (or not a print at
  // all, like a cabinet along the top), so it's never trusted outright.
  const margin = Math.max(2, Math.round(Math.min(w, h) * 0.01));
  for (const d of out) {
    if (d.quad.some((p) => p.x < margin || p.y < margin || p.x > w - margin || p.y > h - margin)) { d.doubtful = true; d.touchesEdge = true; }
  }
  return out.sort((a, b) => (a.quad[0].y + a.quad[2].y) - (b.quad[0].y + b.quad[2].y) || a.quad[0].x - b.quad[0].x);
}
