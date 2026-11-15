import { describe, expect, it } from 'vitest';
import { batchVerdicts, makeSig, type Sig } from '../src/lib/vision/match';
import { buildContext, matchPrint, orbVerdict, photoOrbs } from '../src/lib/vision/matcher';
import type { Orb } from '../src/lib/vision/orb';
import { fitSize, resizeRaster, type Raster } from '../src/lib/vision/raster';

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

/** A detailed made-up "photo": many small shapes and textures, like real scenes. */
function detailedPhoto(seed: number, w: number, h: number): Raster {
  const r = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  const bg = [r() * 255, r() * 255, r() * 255];
  for (let i = 0; i < w * h; i++) data.set([bg[0], bg[1], bg[2], 255], i * 4);
  for (let s = 0; s < 140; s++) {
    const x0 = Math.floor(r() * w), y0 = Math.floor(r() * h);
    const sw = 4 + Math.floor(r() * w * 0.12), sh = 4 + Math.floor(r() * h * 0.12);
    const c = [r() * 255, r() * 255, r() * 255], round = r() < 0.5;
    for (let y = y0; y < Math.min(h, y0 + sh); y++) for (let x = x0; x < Math.min(w, x0 + sw); x++) {
      if (round && ((x - x0 - sw / 2) / (sw / 2)) ** 2 + ((y - y0 - sh / 2) / (sh / 2)) ** 2 > 1) continue;
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { w, h, data };
}

const shrink = (img: Raster, edge: number) => { const t = fitSize(img.w, img.h, edge); return resizeRaster(img, t.w, t.h); };

/** A print: 3:2 crop, colour shift, then seen small in a floor photo. */
function asPrint(photo: Raster, seed: number, edge: number): Raster {
  const r = rng(seed);
  const ch = Math.round(photo.w / 1.5), y0 = Math.round((photo.h - ch) / 2);
  const data = new Uint8ClampedArray(photo.w * ch * 4);
  const gain = [0.85 + r() * 0.25, 0.85 + r() * 0.25, 0.85 + r() * 0.25];
  for (let y = 0; y < ch; y++) for (let x = 0; x < photo.w; x++) {
    const i = ((y + y0) * photo.w + x) * 4, o = (y * photo.w + x) * 4;
    for (let k = 0; k < 3; k++) data[o + k] = photo.data[i + k] * gain[k] + 8;
    data[o + 3] = 255;
  }
  return shrink({ w: photo.w, h: ch, data }, edge);
}

describe('feature-point matching', () => {
  it('matches prints to their photos even when the prints are tiny in the floor photo', () => {
    const photos = Array.from({ length: 40 }, (_, i) => detailedPhoto(100 + i, 640, 480));
    const sigs = new Map<string, Sig>(), orbs = new Map<string, Orb[]>();
    photos.forEach((p, i) => { const thumb = shrink(p, 480); sigs.set(`p${i}`, makeSig(thumb)); orbs.set(`p${i}`, photoOrbs(thumb)); });
    const ctx = buildContext(sigs, orbs);
    for (const edge of [100, 240]) {
      const picks = [3, 7, 12, 18, 25, 31, 36];
      const lists = picks.map((i, n) => matchPrint(asPrint(photos[i], 50 + n, edge), ctx));
      const dec = batchVerdicts(lists, () => false, [], orbVerdict);
      let right = 0, wrong = 0;
      dec.forEach((d, n) => { if (d.verdict === 'match') { if (d.id === `p${picks[n]}`) right++; else wrong++; } });
      expect(wrong, `print ${edge}px`).toBe(0);
      expect(right, `print ${edge}px`).toBeGreaterThanOrEqual(6);
    }
  }, 60000);
});

import { matchFloor, matchPrintAt } from '../src/lib/vision/matcher';
import { applyH, homography, type Pt, type Quad } from '../src/lib/vision/warp';
import { bilinearRGBA } from '../src/lib/vision/raster';

function paste(dst: Raster, img: Raster, quad: Pt[]) {
  const H = homography(quad, [{ x: 0, y: 0 }, { x: img.w, y: 0 }, { x: img.w, y: img.h }, { x: 0, y: img.h }]);
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++) {
    const p = applyH(H, x + 0.5, y + 0.5);
    if (p.x < 0 || p.y < 0 || p.x >= img.w || p.y >= img.h) continue;
    dst.data.set(bilinearRGBA(img, p.x - 0.5, p.y - 0.5), (y * dst.w + x) * 4);
  }
}

describe('matching with an outline that is off', () => {
  it('finds the print and corrects the outline when it is off by half a print', () => {
    const photos = Array.from({ length: 30 }, (_, i) => detailedPhoto(300 + i, 640, 480));
    const sigs = new Map<string, Sig>(), orbs = new Map<string, Orb[]>();
    photos.forEach((p, i) => { const thumb = shrink(p, 480); sigs.set(`p${i}`, makeSig(thumb)); orbs.set(`p${i}`, photoOrbs(thumb)); });
    const ctx = buildContext(sigs, orbs);
    // A row of touching prints, each ~140 px wide, on a plain floor.
    const W = 1400, H = 400, pw = 140, ph = 93;
    const scene: Raster = { w: W, h: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
    const order = [4, 9, 13, 2, 21, 17, 26, 8];
    order.forEach((idx, n) => {
      const x0 = 100 + n * (pw + 2), y0 = 150;
      paste(scene, asPrint(photos[idx], 70 + n, 640), [{ x: x0, y: y0 }, { x: x0 + pw, y: y0 }, { x: x0 + pw, y: y0 + ph }, { x: x0, y: y0 + ph }]);
    });
    const centres = new Map(order.map((idx, n) => [`p${idx}`, { x: 100 + n * (pw + 2) + pw / 2, y: 150 + ph / 2 }]));
    const quads: { quad: Quad; doubtful: boolean }[] = order.map((_, n) => {
      // Outline shifted right by half a print and down a little: it straddles two prints.
      const x0 = 100 + n * (pw + 2) + pw * 0.5, y0 = 150 + ph * 0.15;
      return { quad: [{ x: x0, y: y0 }, { x: x0 + pw, y: y0 }, { x: x0 + pw, y: y0 + ph }, { x: x0, y: y0 + ph }], doubtful: false };
    });
    void matchPrintAt;
    const res = matchFloor(scene, quads, ctx, () => false);
    let good = 0, wrong = 0;
    for (const r of res) {
      if (r.verdict !== 'match') continue;
      const truth = centres.get(r.chosen!)!;
      const ac = { x: r.quad.reduce((s2, p) => s2 + p.x, 0) / 4, y: r.quad.reduce((s2, p) => s2 + p.y, 0) / 4 };
      // A confident match must put its outline on that photo's real print.
      if (Math.hypot(ac.x - truth.x, ac.y - truth.y) < pw * 0.15) good++; else wrong++;
    }
    expect(wrong).toBe(0);
    expect(good).toBeGreaterThanOrEqual(6);
    // The misplaced outlines are replaced, not kept as extra "?" prints.
    expect(res.filter((r) => r.verdict !== 'match').length).toBeLessThanOrEqual(1);
  }, 60000);
});
