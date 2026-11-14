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
function backgroundPalette(r: Raster, k = 4): [number, number, number][] {
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
    centers = sums.filter((t) => t[3] > samples.length * 0.03).map((t) => [t[0] / t[3], t[1] / t[3], t[2] / t[3]]);
    if (!centers.length) centers = [samples[0]];
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

interface Blob { area: number; pts: Pt[]; touchesEdge: boolean }

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
    const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1);
    let y0 = h, y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      area++;
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
    blobs.push({ area, pts, touchesEdge: edge });
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
    const out = Math.max(3, perp * 0.4), inn = Math.max(2, perp * 0.04);
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
    // Fraction of a line (at end offsets oa, ob) that looks like table.
    const bgFrac = (oa: number, ob: number) => {
      let c = 0, n2 = 0;
      for (let k = 0; k < 16; k++) {
        const t = 0.1 + 0.8 * (k + 0.5) / 16, o = oa + (ob - oa) * t;
        const xi = Math.round(a.x + (b.x - a.x) * t + n.x * o), yi = Math.round(a.y + (b.y - a.y) * t + n.y * o);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        n2++;
        if (bg(xi, yi)) c++;
      }
      return n2 ? c / n2 : 1;
    };
    // Growing outward must not cross a strip of plain table: that's a gap between prints.
    const crossesGap = (oa: number, ob: number) => {
      const reach = Math.max(oa, ob);
      for (let o = 3; o < reach - 2; o += 2) {
        const f = o / reach;
        if (bgFrac(Math.max(0, oa) * f, Math.max(0, ob) * f) > 0.8) return true;
      }
      return false;
    };
    // Take the nearest strong border, not the strongest: going too far out
    // would grab the far edge of a neighbouring print.
    const cands: [number, number, number][] = [];
    for (let oa = -inn; oa <= out; oa += step) for (let ob = -inn; ob <= out; ob += step) {
      const s = score(oa, ob);
      cands.push([s, oa, ob]);
      if (s > best) best = s;
    }
    let nearest = Infinity;
    cands.sort((x, y) => (Math.max(0, x[1]) + Math.max(0, x[2])) - (Math.max(0, y[1]) + Math.max(0, y[2])));
    for (const [s, oa, ob] of cands) {
      const travel = Math.max(0, oa) + Math.max(0, ob);
      if (s >= best * 0.6 && travel < nearest && !crossesGap(oa, ob)) { nearest = travel; bestA = oa; bestB = ob; }
    }
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
  return a1 > a0 * 0.85 && a1 < a0 * 3 ? (pts as Quad) : q;
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
  const noise = border[Math.floor(border.length * 0.98)] ?? 0;
  const t = Math.max(14, Math.min(noise * 1.4 + 4, otsu(dist, maxD)));
  let mask: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = dist[i] > t ? 1 : 0;

  const unit = Math.max(1, Math.round(Math.max(w, h) / 500));
  mask = morph(morph(mask, w, h, unit, true), w, h, unit, false); // close small gaps
  mask = fillHoles(mask, w, h);
  mask = morph(morph(mask, w, h, unit * 3, false), w, h, unit * 3, true); // open: cut thin bridges

  const minArea = (opts.minArea ?? 0.004) * w * h;
  const grad = sobel(img);
  const bgT = t * 0.75;
  const isBg = (x: number, y: number) => dist[y * w + x] < bgT;
  const out: Detection[] = [];
  for (const b of components(mask, w, h, minArea)) {
    const hull = convexHull(b.pts);
    const quad = maxAreaQuad(hull);
    if (!quad) continue;
    const rough = normalizeQuad(quad);
    const ra = polygonArea(rough);
    const fill = Math.min(b.area / ra, ra / b.area);
    const hullFill = ra / polygonArea(hull);
    const q = normalizeQuad(refineQuad(rough, w, h, grad, isBg));
    const qa = polygonArea(q);
    const doubtful = fill < 0.86 || hullFill < 0.9 || !cornerAnglesOk(q) || b.touchesEdge;
    out.push({ quad: q, fill, area: qa, doubtful, touchesEdge: b.touchesEdge });
  }
  return out.sort((a, b) => (a.quad[0].y + a.quad[2].y) - (b.quad[0].y + b.quad[2].y) || a.quad[0].x - b.quad[0].x);
}
