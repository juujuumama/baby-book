import { detectPrints, type Detection } from './detect';
import { makeSig, rankMatches, type Candidate, type Sig } from './match';
import { fitSize, resizeRaster, type Raster } from './raster';
import { landscapeOrder, warpQuad, type Quad } from './warp';

export const DETECT_EDGE = 1000;

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

/** Find every print in a photo of a table and rank library matches for each. */
export function analyzeTable(src: Raster, library: Map<string, Sig>): FoundPrint[] {
  const d = fitSize(src.w, src.h, DETECT_EDGE);
  const small = d.scale < 1 ? resizeRaster(src, d.w, d.h) : src;
  const k = src.w / small.w;
  const dets: Detection[] = detectPrints(small);
  return dets.map((det) => {
    const quad = det.quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad;
    const { image, sig } = printSig(src, quad);
    return { quad, doubtful: det.doubtful, image, candidates: rankMatches(sig, library) };
  });
}
