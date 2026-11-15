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
