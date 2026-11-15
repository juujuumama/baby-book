import type { Raster } from './raster';
import type { Pt, Quad } from './warp';

// Fit a print outline around a spot the user tapped: try print-sized
// rectangles near that spot (size and angle taken from neighbouring prints)
// and keep the one whose four sides sit best on real edges.

export interface Grad { gx: Float32Array; gy: Float32Array; w: number; h: number }

/** Colour gradient: per pixel, the channel that changes most. */
export function colorGradient(r: Raster): Grad {
  const { w, h, data } = r;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let bx = 0, by = 0, bm = -1;
    for (let c = 0; c < 3; c++) {
      const p = (k: number) => data[k * 4 + c];
      const sx = (p(i - w + 1) + 2 * p(i + 1) + p(i + w + 1)) - (p(i - w - 1) + 2 * p(i - 1) + p(i + w - 1));
      const sy = (p(i + w - 1) + 2 * p(i + w) + p(i + w + 1)) - (p(i - w - 1) + 2 * p(i - w) + p(i - w + 1));
      const m = sx * sx + sy * sy;
      if (m > bm) { bm = m; bx = sx; by = sy; }
    }
    gx[i] = bx; gy[i] = by;
  }
  return { gx, gy, w, h };
}

function sideSupport(g: Grad, cx: number, cy: number, a: number, lw: number, lh: number): number {
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  const PER = 14, NORM = 160;
  const sides: [number, number, number, number, number, number][] = [
    [-lw / 2, -lh / 2, lw, 0, 0, -1], [lw / 2, -lh / 2, 0, lh, 1, 0], [lw / 2, lh / 2, -lw, 0, 0, 1], [-lw / 2, lh / 2, 0, -lh, -1, 0],
  ];
  let logSum = 0;
  for (const [u0, v0, du, dv, nu, nv] of sides) {
    const nx = ux * nu + vx * nv, ny = uy * nu + vy * nv;
    let hits = 0;
    for (let k = 0; k < PER; k++) {
      const t = (k + 0.5) / PER, u = u0 + du * t, v = v0 + dv * t;
      const x = cx + ux * u + vx * v, y = cy + uy * u + vy * v;
      let e = 0;
      for (const o of [-2, -1, 0, 1, 2]) {
        const xi = Math.round(x + nx * o), yi = Math.round(y + ny * o);
        if (xi < 1 || yi < 1 || xi >= g.w - 1 || yi >= g.h - 1) continue;
        const i = yi * g.w + xi;
        e = Math.max(e, Math.abs(g.gx[i] * nx + g.gy[i] * ny));
      }
      hits += Math.min(1, e / NORM);
    }
    logSum += Math.log(0.05 + hits / PER);
  }
  return Math.exp(logSum / 4);
}

/** Typical outline size and angle near a point, from prints already found. */
export function neighbourShape(quads: Quad[], at: Pt): { long: number; short: number; angle: number } | null {
  if (!quads.length) return null;
  const c = (q: Quad) => ({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 });
  const near = [...quads].sort((a, b) => Math.hypot(c(a).x - at.x, c(a).y - at.y) - Math.hypot(c(b).x - at.x, c(b).y - at.y)).slice(0, 5);
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const sides = near.map((q) => {
    const e0 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), e1 = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
    const a = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
    return { long: Math.max(e0, e1), short: Math.min(e0, e1), angle: ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) };
  });
  // Angles near 0 and near 90° are the same orientation; centre them on 0.
  const angles = sides.map((s) => (s.angle > Math.PI / 4 ? s.angle - Math.PI / 2 : s.angle));
  return { long: med(sides.map((s) => s.long)), short: med(sides.map((s) => s.short)), angle: med(angles) };
}

export function fitPrintAt(g: Grad, at: Pt, shape: { long: number; short: number; angle: number }): Quad {
  const { long: L, short: S, angle: a0 } = shape;
  let best = { score: -1, cx: at.x, cy: at.y, a: a0, lw: S, lh: L };
  const step = Math.max(1, S / 20), reach = S * 0.45;
  for (let dy = -reach; dy <= reach; dy += step) for (let dx = -reach; dx <= reach; dx += step) {
    for (let da = -0.08; da <= 0.081; da += 0.04) for (const f of [0.92, 1, 1.08]) for (const [lw, lh] of [[S * f, L * f], [L * f, S * f]]) {
      const sc = sideSupport(g, at.x + dx, at.y + dy, a0 + da, lw, lh);
      if (sc > best.score) best = { score: sc, cx: at.x + dx, cy: at.y + dy, a: a0 + da, lw, lh };
    }
  }
  // Polish.
  const b0 = { ...best };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (const da of [-0.02, -0.01, 0, 0.01, 0.02]) for (const f of [0.97, 1, 1.03]) {
    const sc = sideSupport(g, b0.cx + dx, b0.cy + dy, b0.a + da, b0.lw * f, b0.lh * f);
    if (sc > best.score) best = { score: sc, cx: b0.cx + dx, cy: b0.cy + dy, a: b0.a + da, lw: b0.lw * f, lh: b0.lh * f };
  }
  const { cx, cy, a, lw, lh } = best;
  const ux = Math.cos(a), uy = Math.sin(a);
  const P = (u: number, v: number): Pt => ({ x: cx + ux * u - uy * v, y: cy + uy * u + ux * v });
  return [P(-lw / 2, -lh / 2), P(lw / 2, -lh / 2), P(lw / 2, lh / 2), P(-lw / 2, lh / 2)];
}
