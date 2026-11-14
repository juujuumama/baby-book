import { resizeRaster, fitSize, type Raster } from './raster';

// Fingerprints for matching a print back to its digital photo.
//
// Each library photo keeps a tiny grey image (96 px long edge) and a tinier
// colour one (24 px). A print is straightened, turned landscape, and compared
// against every photo with normalised cross-correlation, which shrugs off the
// brightness, contrast and colour-cast differences between paper and screen.
//
// Prints are usually cropped (a 4x6 print of a 4:3 iPhone photo loses ~11%),
// and may lie in any rotation, so each photo is tried centre-cropped to the
// print's shape, at 0° and 180° (or all four turns for square prints), with
// a little slack in where the crop falls.

export interface Sig { w: number; h: number; gray: Uint8Array; cw: number; ch: number; rgb: Uint8Array }

export const SIG_EDGE = 96;
export const SIG_COLOR_EDGE = 24;

export function makeSig(r: Raster): Sig {
  const g = fitSize(r.w, r.h, SIG_EDGE);
  const small = resizeRaster(r, g.w, g.h);
  const gray = new Uint8Array(g.w * g.h);
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    gray[i] = Math.round(0.299 * small.data[j] + 0.587 * small.data[j + 1] + 0.114 * small.data[j + 2]);
  }
  const c = fitSize(r.w, r.h, SIG_COLOR_EDGE);
  const tiny = resizeRaster(small, c.w, c.h);
  const rgb = new Uint8Array(c.w * c.h * 3);
  for (let i = 0; i < c.w * c.h; i++) { rgb[i * 3] = tiny.data[i * 4]; rgb[i * 3 + 1] = tiny.data[i * 4 + 1]; rgb[i * 3 + 2] = tiny.data[i * 4 + 2]; }
  return { w: g.w, h: g.h, gray, cw: c.w, ch: c.h, rgb };
}

/** Common print shapes (long:short). Measured shapes snap to these. */
const PRINT_ASPECTS = [1.5, 1.4, 1.25, 4 / 3, 1, 16 / 9];

export function snapAspect(a: number): number {
  let best = a, bd = 0.06;
  for (const p of PRINT_ASPECTS) { const d = Math.abs(a - p) / p; if (d < bd) { bd = d; best = p; } }
  return best;
}

function sample(buf: Uint8Array, w: number, h: number, ch: number, c: number, x: number, y: number): number {
  x = Math.min(Math.max(x * w - 0.5, 0), w - 1);
  y = Math.min(Math.max(y * h - 0.5, 0), h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = buf[(y0 * w + x0) * ch + c], b = buf[(y0 * w + x1) * ch + c];
  const d = buf[(y1 * w + x0) * ch + c], e = buf[(y1 * w + x1) * ch + c];
  const top = a + (b - a) * fx, bot = d + (e - d) * fx;
  return top + (bot - top) * fy;
}

/** Map a point in the landscape view (after `rot` quarter turns) back to the original image. */
function unrotate(rot: number, s: number, t: number): [number, number] {
  switch (rot & 3) {
    case 0: return [s, t];
    case 1: return [t, 1 - s];
    case 2: return [1 - s, 1 - t];
    default: return [1 - t, s];
  }
}

interface View { rot: number; x0: number; y0: number; cw: number; ch: number }

const INSET = 0.06;

/** Correlation over the cells the print marks as usable (not glare or blown out). */
function maskedNcc(p: Float32Array, l: Float32Array, m: Uint8Array | null): number {
  if (!m) return dot(p, l);
  let n = 0, sp = 0, sl = 0;
  for (let i = 0; i < p.length; i++) if (m[i]) { n++; sp += p[i]; sl += l[i]; }
  if (n < p.length * 0.4) return dot(p, l);
  sp /= n; sl /= n;
  let num = 0, dp = 0, dl = 0;
  for (let i = 0; i < p.length; i++) if (m[i]) { const a = p[i] - sp, b = l[i] - sl; num += a * b; dp += a * a; dl += b * b; }
  return num / (Math.sqrt(dp * dl) || 1);
}

function normalize(v: Float32Array): Float32Array {
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= m; s += v[i] * v[i]; }
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function gridFor(aspect: number, cols: number) {
  return { gw: cols, gh: Math.max(4, Math.round(cols / aspect)) };
}

/** Grey + colour feature vectors for a view of a library photo. */
function libraryFeatures(sig: Sig, v: View, aspect: number, cols: number) {
  const { gw, gh } = gridFor(aspect, cols);
  const g = new Float32Array(gw * gh);
  const ccols = Math.max(6, Math.round(cols / 4)), { gw: cgw, gh: cgh } = gridFor(aspect, ccols);
  const c = [new Float32Array(cgw * cgh), new Float32Array(cgw * cgh), new Float32Array(cgw * cgh)];
  const span = 1 - 2 * INSET;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const s = v.x0 + (INSET + span * (i + 0.5) / gw) * v.cw, t = v.y0 + (INSET + span * (j + 0.5) / gh) * v.ch;
    const [x, y] = unrotate(v.rot, s, t);
    g[j * gw + i] = sample(sig.gray, sig.w, sig.h, 1, 0, x, y);
  }
  for (let j = 0; j < cgh; j++) for (let i = 0; i < cgw; i++) {
    const s = v.x0 + (INSET + span * (i + 0.5) / cgw) * v.cw, t = v.y0 + (INSET + span * (j + 0.5) / cgh) * v.ch;
    const [x, y] = unrotate(v.rot, s, t);
    for (let k = 0; k < 3; k++) c[k][j * cgw + i] = sample(sig.rgb, sig.cw, sig.ch, 3, k, x, y);
  }
  return { g: normalize(g), c: c.map(normalize) };
}

type Features = { g: Float32Array; c: Float32Array[]; gm?: Uint8Array | null; cm?: Uint8Array | null };

/** The same features for a straightened, landscape print, plus a mask of usable cells. */
export function printFeatures(print: Sig, aspect: number, cols: number): Features {
  const f: Features = libraryFeatures(print, { rot: 0, x0: 0, y0: 0, cw: 1, ch: 1 }, aspect, cols);
  // Cells where any colour channel is blown out (glare, over-exposure) carry no detail.
  const usable = (gw: number, gh: number) => {
    const m = new Uint8Array(gw * gh);
    let bad = 0;
    const span = 1 - 2 * INSET;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const s = INSET + span * (i + 0.5) / gw, t = INSET + span * (j + 0.5) / gh;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const v = sample(print.rgb, print.cw, print.ch, 3, k, s, t);
        if (v > 242) ok = false;
      }
      m[j * gw + i] = ok ? 1 : 0;
      if (!ok) bad++;
    }
    if (!bad) return null;
    // Glare fades out around its bright core; drop the cells next to it too.
    const grown = new Uint8Array(m);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      if (m[j * gw + i]) continue;
      const r = Math.max(1, Math.round(gw / 16));
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const y = j + dj, x = i + di;
        if (x >= 0 && y >= 0 && x < gw && y < gh) grown[y * gw + x] = 0;
      }
    }
    return grown;
  };
  const g = gridFor(aspect, cols), c = gridFor(aspect, Math.max(6, Math.round(cols / 4)));
  f.gm = usable(g.gw, g.gh);
  f.cm = usable(c.gw, c.gh);
  return f;
}

/** Candidate views of a library photo for a print of the given (landscape) aspect. */
function views(sig: Sig, aspect: number, offsets: number[], scales: number[]): View[] {
  const portrait = sig.h > sig.w;
  const la = Math.max(sig.w, sig.h) / Math.min(sig.w, sig.h);
  const square = Math.abs(la - 1) < 0.08 || Math.abs(aspect - 1) < 0.08;
  const rots = square ? [0, 1, 2, 3] : portrait ? [1, 3] : [0, 2];
  const out: View[] = [];
  for (const rot of rots) {
    // For square prints of non-square photos, the landscape frame depends on rot.
    const frameAspect = (rot & 1) === (portrait ? 1 : 0) ? la : 1 / la;
    for (const sc of scales) {
      let cw: number, ch: number;
      if (aspect > frameAspect) { cw = sc; ch = (frameAspect / aspect) * sc; } else { ch = sc; cw = (aspect / frameAspect) * sc; }
      const slackX = 1 - cw, slackY = 1 - ch;
      for (const o of offsets) {
        out.push({ rot, cw, ch, x0: slackX / 2 + (slackX > slackY ? o * slackX / 2 : 0), y0: slackY / 2 + (slackY >= slackX ? o * slackY / 2 : 0) });
      }
    }
  }
  return out;
}

export interface Candidate { id: string; score: number }

function score(p: Features, l: Features): number {
  const color = (maskedNcc(p.c[0], l.c[0], p.cm ?? null) + maskedNcc(p.c[1], l.c[1], p.cm ?? null) + maskedNcc(p.c[2], l.c[2], p.cm ?? null)) / 3;
  return 0.75 * maskedNcc(p.g, l.g, p.gm ?? null) + 0.25 * color;
}

// Coarse library features depend only on (photo, aspect), so cache them; this
// keeps the live camera mode fast.
let coarseCache = new WeakMap<Sig, Map<string, Features[]>>();
const COARSE = { cols: 24, offsets: [-0.8, 0, 0.8], scales: [1] };
const FINE = { cols: 40, offsets: [-1, -0.5, 0, 0.5, 1], scales: [1, 0.95, 0.9] };

export function clearMatchCache() { coarseCache = new WeakMap(); }

/** Rank library photos for one print. `print` is a signature of the straightened, landscape print. */
export function rankMatches(print: Sig, library: Map<string, Sig>, topN = 5): Candidate[] {
  const aspect = snapAspect(print.w / print.h);
  const pc = printFeatures(print, aspect, COARSE.cols);
  const coarse: Candidate[] = [];
  for (const [id, sig] of library) {
    const key = aspect.toFixed(3);
    let perSig = coarseCache.get(sig);
    if (!perSig) coarseCache.set(sig, (perSig = new Map()));
    let feats = perSig.get(key);
    if (!feats) {
      feats = views(sig, aspect, COARSE.offsets, COARSE.scales).map((v) => libraryFeatures(sig, v, aspect, COARSE.cols));
      perSig.set(key, feats);
    }
    let best = -1;
    for (const f of feats) best = Math.max(best, score(pc, f));
    coarse.push({ id, score: best });
  }
  coarse.sort((a, b) => b.score - a.score);
  const pf = printFeatures(print, aspect, FINE.cols);
  const fine = coarse.slice(0, Math.max(topN, 12)).map(({ id }) => {
    const sig = library.get(id)!;
    let best = -1;
    for (const v of views(sig, aspect, FINE.offsets, FINE.scales)) best = Math.max(best, score(pf, libraryFeatures(sig, v, aspect, FINE.cols)));
    return { id, score: best };
  });
  return fine.sort((a, b) => b.score - a.score).slice(0, topN);
}

export type Verdict = 'match' | 'unsure' | 'none';

/**
 * Decide how sure we are. `sameMoment` says whether two photos were taken
 * within a couple of minutes (bursts): either is then fine for sorting.
 */
export function verdict(c: Candidate[], sameMoment: (a: string, b: string) => boolean): Verdict {
  const [a, b] = c;
  if (!a || a.score < 0.45) return 'none';
  const margin = b ? a.score - b.score : 1;
  if (a.score >= 0.8 || (a.score >= 0.6 && (margin >= 0.06 || sameMoment(a.id, b.id)))) return 'match';
  return 'unsure';
}

/**
 * Verdicts for a whole batch. A photo is normally printed once, so when two
 * prints both claim the same photo, the weaker claim gives way and is judged
 * on its remaining candidates.
 */
export function batchVerdicts(lists: Candidate[][], sameMoment: (a: string, b: string) => boolean): { verdict: Verdict; id: string | null }[] {
  const order = lists.map((c, i) => ({ i, s: c[0]?.score ?? 0 })).sort((a, b) => b.s - a.s);
  const claimed = new Set<string>();
  const out: Verdict[] = new Array(lists.length).fill('none');
  const chosen: (string | null)[] = new Array(lists.length).fill(null);
  for (const { i } of order) {
    const rest = lists[i].filter((c) => !claimed.has(c.id));
    const v = verdict(rest, sameMoment);
    out[i] = rest.length === lists[i].length ? v : v === 'match' ? 'match' : 'unsure';
    if (v === 'match') { claimed.add(rest[0].id); chosen[i] = rest[0].id; }
  }
  return out.map((v, i) => ({ verdict: v, id: chosen[i] }));
}
