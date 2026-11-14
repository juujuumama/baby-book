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
      const big = kept.map((t, i) => [t[3], i] as const).filter(([n]) => n > samples.length * share).map(([, i]) => centers[i]);
      if (big.length) centers = big;
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
 * Prints that touch or overlap merge into one blob. Since a batch is usually
 * all one print size (learned from the prints lying on their own), fill the
 * blob greedily with print-sized rectangles: each must sit inside the blob,
 * cover new ground, and line up with the blob's outer edges.
 */
function packCluster(b: Blob, w: number, h: number, L: number, S: number, typical: number): Quad[] {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const i of b.pixels) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const m = new Uint8Array(bw * bh);
  for (const i of b.pixels) { const x = i % w, y = (i - x) / w; m[(y - y0) * bw + (x - x0)] = 1; }
  const covered = new Uint8Array(bw * bh);
  const at = (x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < bw && yi < bh ? m[yi * bw + xi] : 0; };
  const cov = (x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < bw && yi < bh ? covered[yi * bw + xi] : 1; };

  // Candidate angles: the cluster's own rectangle plus its long straight sides.
  const hull = convexHull(b.pts.map((p) => ({ x: p.x - x0, y: p.y - y0 })));
  const angles: number[] = [];
  const addAngle = (a: number) => {
    a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    if (!angles.some((t) => Math.min(Math.abs(t - a), Math.PI / 2 - Math.abs(t - a)) < 0.035)) angles.push(a);
  };
  const r0 = minAreaRect(hull);
  if (r0) addAngle(Math.atan2(r0[1].y - r0[0].y, r0[1].x - r0[0].x));
  const edges = hull.map((p, i) => { const q = hull[(i + 1) % hull.length]; return { a: Math.atan2(q.y - p.y, q.x - p.x), len: Math.hypot(q.x - p.x, q.y - p.y) }; })
    .filter((e) => e.len > S * 0.5).sort((a, b2) => b2.len - a.len);
  for (const e of edges) { if (angles.length >= 4) break; addAngle(e.a); }

  const quads: Quad[] = [];
  const IN = 10, JN = 7, PER = 28;
  type Place = { cx: number; cy: number; a: number; lw: number; lh: number; score: number };
  const evaluate = (cx: number, cy: number, a: number, lw: number, lh: number): Place | null => {
    const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
    const P = (u: number, v: number) => [cx + ux * u + vx * v, cy + uy * u + vy * v] as const;
    // Quick reject on the corners.
    for (const [su, sv] of [[-0.42, -0.42], [0.42, -0.42], [0.42, 0.42], [-0.42, 0.42]]) { const [x, y] = P(su * lw, sv * lh); if (!at(x, y)) return null; }
    let inside = 0, fresh = 0;
    for (let j = 0; j < JN; j++) for (let i = 0; i < IN; i++) {
      const [x, y] = P(((i + 0.5) / IN - 0.5) * lw * 0.94, ((j + 0.5) / JN - 0.5) * lh * 0.94);
      if (at(x, y)) { inside++; if (!cov(x, y)) fresh++; }
    }
    const n = IN * JN;
    if (inside < n * 0.94 || fresh < n * 0.5) return null;
    let outside = 0;
    for (let k = 0; k < PER; k++) {
      const t = (k + 0.5) / PER * 4, side = Math.floor(t), f = t - side - 0.5;
      const [u, v] = side === 0 ? [f * lw, -lh / 2 - 3] : side === 1 ? [lw / 2 + 3, f * lh] : side === 2 ? [-f * lw, lh / 2 + 3] : [-lw / 2 - 3, -f * lh];
      const [x, y] = P(u, v);
      if (!at(x, y)) outside++;
    }
    return { cx, cy, a, lw, lh, score: outside / PER + 0.3 * fresh / n };
  };

  // Never place more prints than the cluster's area can hold.
  const maxPrints = Math.max(1, Math.ceil((b.area / typical) * 1.1));
  for (let iter = 0; iter < maxPrints; iter++) {
    let remaining = 0;
    for (let i = 0; i < m.length; i++) if (m[i] && !covered[i]) remaining++;
    if (remaining < typical * 0.35) break;
    let best: Place | null = null;
    const step = Math.max(2, Math.round(S / 25));
    for (const a of angles) for (const [lw, lh] of [[L, S], [S, L]]) {
      for (let cy = 0; cy < bh; cy += step) for (let cx = 0; cx < bw; cx += step) {
        if (!m[cy * bw + cx]) continue;
        const pl = evaluate(cx, cy, a, lw, lh);
        if (pl && (!best || pl.score > best.score)) best = pl;
      }
    }
    if (!best) break;
    // Polish: small shifts, turns and size changes.
    for (let pass = 0; pass < 2; pass++) {
      const b0: Place = best;
      for (const dx of [-2, -1, 0, 1, 2]) for (const dy of [-2, -1, 0, 1, 2]) for (const da of [-0.02, 0, 0.02]) for (const sc of [0.97, 1, 1.03]) {
        const pl = evaluate(b0.cx + dx, b0.cy + dy, b0.a + da, b0.lw * sc, b0.lh * sc);
        if (pl && pl.score > best.score + 1e-6) best = pl;
      }
    }
    const { cx, cy, a, lw, lh } = best;
    const ux = Math.cos(a), uy = Math.sin(a);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const dx = x - cx, dy = y - cy;
      if (Math.abs(dx * ux + dy * uy) <= lw / 2 && Math.abs(-dx * uy + dy * ux) <= lh / 2) covered[y * bw + x] = 1;
    }
    const corner = (u: number, v: number): Pt => ({ x: x0 + cx + ux * u - uy * v, y: y0 + cy + uy * u + ux * v });
    quads.push(normalizeQuad([corner(-lw / 2, -lh / 2), corner(lw / 2, -lh / 2), corner(lw / 2, lh / 2), corner(-lw / 2, lh / 2)]));
  }
  return quads;
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

  const grad = sobel(img);
  const unit = Math.max(1, Math.round(Math.max(w, h) / 500));
  mask = morph(morph(mask, w, h, unit, true), w, h, unit, false); // close small gaps
  mask = fillHoles(mask, w, h);
  mask = morph(morph(mask, w, h, unit * 3, false), w, h, unit * 3, true); // open: cut thin bridges

  const minArea = (opts.minArea ?? 0.004) * w * h;
  const bgT = t * 0.75;
  const isBg = (x: number, y: number) => dist[y * w + x] < bgT;
  const out: Detection[] = [];
  const blobs = components(mask, w, h, minArea);
  const fits = blobs.map(fitBlob);
  // Typical print size, from the blobs that are clearly single prints.
  const goodAreas = blobs.filter((_, i) => fits[i]?.good && !blobs[i].touchesEdge).map((b) => b.area).sort((a, b) => a - b);
  const typical = goodAreas.length ? goodAreas[Math.floor(goodAreas.length / 2)] : 0;
  // Typical print shape, for unpacking clusters of touching prints.
  const sides: number[][] = [];
  blobs.forEach((b, i) => {
    const f = fits[i];
    if (!f?.good || b.touchesEdge) return;
    const q = f.rough, e0 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), e1 = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
    sides.push([Math.max(e0, e1), Math.min(e0, e1)]);
  });
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const L = sides.length ? med(sides.map((s2) => s2[0])) : 0, S = sides.length ? med(sides.map((s2) => s2[1])) : 0;

  blobs.forEach((b, i) => {
    const f = fits[i];
    if (!f) return;
    const big = typical > 0 && b.area > typical * 1.15;
    if (!f.good && !b.touchesEdge && big && L > 0) {
      const quads = packCluster(b, w, h, L, S, typical);
      if (quads.length >= 1) {
        // Cluster pieces keep their packed outline: snapping would reach into the neighbour.
        for (const q of quads) out.push({ quad: q, fill: 1, area: polygonArea(q), doubtful: false, touchesEdge: false });
        return;
      }
    }
    const q = normalizeQuad(refineQuad(f.rough, w, h, grad, isBg));
    const qa = polygonArea(q);
    const doubtful = !f.good || !cornerAnglesOk(q) || b.touchesEdge || (typical > 0 && (qa > typical * 1.8 || qa < typical * 0.4));
    out.push({ quad: q, fill: f.fill, area: qa, doubtful, touchesEdge: b.touchesEdge });
  });
  return out.sort((a, b) => (a.quad[0].y + a.quad[2].y) - (b.quad[0].y + b.quad[2].y) || a.quad[0].x - b.quad[0].x);
}
