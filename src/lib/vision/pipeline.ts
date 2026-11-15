import { detectPrints, type Detection } from './detect';
import { makeSig, rankMatches, type Candidate, type Sig } from './match';
import { fitSize, resizeRaster, type Raster } from './raster';
import { landscapeOrder, warpQuad, type Quad } from './warp';

export const DETECT_EDGE = 1400;

export interface FoundPrint {
  /** Corners in the coordinates of the raster passed in. */
  quad: Quad;
  doubtful: boolean;
  /** The straightened print (landscape), for showing next to its match. */
  image: Raster;
  candidates: Candidate[];
}

const len = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Straighten one quad from `src` into a landscape raster. */
export function straighten(src: Raster, quad: Quad, maxEdge = 360): Raster {
  const q = landscapeOrder(quad);
  const wq = (len(q[0], q[1]) + len(q[3], q[2])) / 2;
  const hq = (len(q[1], q[2]) + len(q[0], q[3])) / 2;
  const s = Math.min(1, maxEdge / wq);
  return warpQuad(src, q, Math.max(8, Math.round(wq * s)), Math.max(8, Math.round(hq * s)));
}

export function printSig(src: Raster, quad: Quad): { image: Raster; sig: Sig } {
  const image = straighten(src, quad);
  return { image, sig: makeSig(image) };
}

/** True for patches that can't be a photo print: glare on a shiny floor, or near-uniform areas like a dark cabinet. */
export function featureless(r: Raster): boolean {
  const { w, h, data } = r;
  let sum = 0, n = 0, bright = 0, sq = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = (y * w + x) * 4;
    const g = (k: number) => 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
    sum += Math.abs(g(i + 4) - g(i - 4)) + Math.abs(g(i + w * 4) - g(i - w * 4));
    bright += g(i);
    sq += g(i) * g(i);
    n++;
  }
  if (n > 0) {
    const mean = bright / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    // A near-uniform patch (a dark cabinet, a shadow) isn't a photo.
    if (sd < 9) return true;
  }
  // Glare is bright and smooth; a print of clear sky is smooth but not glaring.
  return n > 0 && sum / n < 3 && bright / n > 170;
}

/** Find every print in a photo of a table and rank library matches for each. */
export function analyzeTable(src: Raster, library: Map<string, Sig>): FoundPrint[] {
  const d = fitSize(src.w, src.h, DETECT_EDGE);
  const small = d.scale < 1 ? resizeRaster(src, d.w, d.h) : src;
  const k = src.w / small.w;
  const dets: Detection[] = detectPrints(small);
  const out: FoundPrint[] = [];
  for (const det of dets) {
    const quad = det.quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad;
    const { image, sig } = printSig(src, quad);
    if (featureless(image)) continue;
    out.push({ quad, doubtful: det.doubtful, image, candidates: rankMatches(sig, library) });
  }
  return out;
}
