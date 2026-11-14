import { bilinearRGBA, type Raster } from './raster';

export interface Pt { x: number; y: number }
export type Quad = [Pt, Pt, Pt, Pt]; // clockwise

/** Solve the 3x3 homography mapping each src[i] to dst[i]. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / piv;
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / (row[i] || 1e-12));
  return [...h, 1];
}

export function applyH(h: number[], x: number, y: number): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Reorder a clockwise quad so its first edge is a long edge (output is landscape). */
export function landscapeOrder(q: Quad): Quad {
  const e0 = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const e1 = (dist(q[1], q[2]) + dist(q[0], q[3])) / 2;
  return e0 >= e1 ? q : [q[1], q[2], q[3], q[0]];
}

export function quadAspect(q: Quad): number {
  const e0 = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const e1 = (dist(q[1], q[2]) + dist(q[0], q[3])) / 2;
  return Math.max(e0, e1) / Math.max(1e-6, Math.min(e0, e1));
}

/** Straighten the region inside `q` into a w x h raster. */
export function warpQuad(src: Raster, q: Quad, w: number, h: number): Raster {
  const H = homography(
    [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    q,
  );
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = applyH(H, x + 0.5, y + 0.5);
    out.set(bilinearRGBA(src, p.x - 0.5, p.y - 0.5), (y * w + x) * 4);
  }
  return { w, h, data: out };
}
