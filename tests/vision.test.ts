import { describe, expect, it } from 'vitest';
import { batchVerdicts, makeSig, verdict, type Sig } from '../src/lib/vision/match';
import { analyzeTable } from '../src/lib/vision/pipeline';
import { bilinearRGBA, type Raster } from '../src/lib/vision/raster';
import { applyH, homography, type Pt } from '../src/lib/vision/warp';

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

/** A made-up "photo": gradient, soft blobs, and a few hard-edged shapes. */
function fakePhoto(seed: number, w: number, h: number): Raster {
  const r = rng(seed);
  const col = () => [r() * 255, r() * 255, r() * 255];
  const a = col(), b = col();
  const blobs = Array.from({ length: 4 }, () => ({ x: r() * w, y: r() * h, s: (0.1 + r() * 0.3) * w, c: col() }));
  const shapes = Array.from({ length: 6 }, () => ({ x: r() * w, y: r() * h, rx: (0.05 + r() * 0.2) * w, ry: (0.05 + r() * 0.2) * h, c: col() }));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (x / w + y / h) / 2;
    let px = [0, 1, 2].map((k) => a[k] * (1 - t) + b[k] * t);
    for (const bl of blobs) {
      const f = Math.exp(-((x - bl.x) ** 2 + (y - bl.y) ** 2) / (2 * bl.s * bl.s));
      px = px.map((v, k) => v * (1 - f) + bl.c[k] * f);
    }
    for (const s of shapes) if (((x - s.x) / s.rx) ** 2 + ((y - s.y) / s.ry) ** 2 < 1) px = s.c;
    data.set([...px, 255], (y * w + x) * 4);
  }
  return { w, h, data };
}

function crop(r: Raster, x0: number, y0: number, w: number, h: number): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) data.set(r.data.subarray(((y + y0) * r.w + x0) * 4, ((y + y0) * r.w + x0 + w) * 4), y * w * 4);
  return { w, h, data };
}

/** Make a "print": crop to 3:2 like a 4x6, then shift colours like paper does. */
function toPrint(photo: Raster, seed: number): Raster {
  const r = rng(seed);
  const land = photo.w >= photo.h;
  const p = land ? crop(photo, 0, Math.round((photo.h - photo.w / 1.5) / 2), photo.w, Math.round(photo.w / 1.5))
    : crop(photo, Math.round((photo.w - photo.h / 1.5) / 2), 0, Math.round(photo.h / 1.5), photo.h);
  const gain = [0.8 + r() * 0.3, 0.8 + r() * 0.3, 0.8 + r() * 0.3], off = [r() * 30 - 10, r() * 30 - 10, r() * 30 - 10];
  for (let i = 0; i < p.data.length; i += 4) for (let k = 0; k < 3; k++) p.data[i + k] = p.data[i + k] * gain[k] + off[k];
  return p;
}

function table(w: number, h: number, seed: number): Raster {
  const r = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const grain = Math.sin(y * 0.05 + Math.sin(x * 0.004) * 3) * 12 + (r() - 0.5) * 16;
    data.set([120 + grain, 82 + grain * 0.7, 52 + grain * 0.5, 255], (y * w + x) * 4);
  }
  return { w, h, data };
}

/** Paste `img` onto `dst` so its corners land on `quad`. */
function paste(dst: Raster, img: Raster, quad: Pt[]) {
  const H = homography(quad, [{ x: 0, y: 0 }, { x: img.w, y: 0 }, { x: img.w, y: img.h }, { x: 0, y: img.h }]);
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++) {
    const p = applyH(H, x + 0.5, y + 0.5);
    if (p.x < 0 || p.y < 0 || p.x >= img.w || p.y >= img.h) continue;
    dst.data.set(bilinearRGBA(img, p.x - 0.5, p.y - 0.5), (y * dst.w + x) * 4);
  }
}

function rotatedRect(cx: number, cy: number, w: number, h: number, angle: number): Pt[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
}

describe('print sorting pipeline', () => {
  it('finds and matches prints laid on a table', () => {
    const photos: Raster[] = [];
    const library = new Map<string, Sig>();
    for (let i = 0; i < 40; i++) {
      const p = i % 3 === 0 ? fakePhoto(i + 1, 270, 360) : fakePhoto(i + 1, 360, 270);
      photos.push(p);
      library.set(`p${i}`, makeSig(p));
    }
    const scene = table(1600, 1200, 7);
    const picks = [3, 8, 15, 21, 30, 37];
    const angles = [0.1, -0.3, Math.PI / 2 + 0.15, 0.25, Math.PI + 0.05, -Math.PI / 2 - 0.2];
    const truth: { id: string; cx: number; cy: number }[] = [];
    picks.forEach((idx, n) => {
      const cx = 290 + (n % 3) * 510, cy = 320 + Math.floor(n / 3) * 560;
      const print = toPrint(photos[idx], 100 + n);
      const long = 360, short = 240;
      const [pw, ph] = print.w >= print.h ? [long, short] : [short, long];
      paste(scene, print, rotatedRect(cx, cy, pw, ph, angles[n]));
      truth.push({ id: `p${idx}`, cx, cy });
    });
    // One print of a photo that isn't in the library.
    paste(scene, toPrint(fakePhoto(999, 360, 270), 5), rotatedRect(800, 1132, 150, 100, 0.05));

    const found = analyzeTable(scene, library);
    expect(found.length).toBe(7);
    for (const t of truth) {
      const f = found.find((p) => {
        const cx = p.quad.reduce((s, q) => s + q.x, 0) / 4, cy = p.quad.reduce((s, q) => s + q.y, 0) / 4;
        return Math.hypot(cx - t.cx, cy - t.cy) < 60;
      });
      expect(f, `print ${t.id} detected`).toBeTruthy();
      expect(f!.candidates[0].id).toBe(t.id);
      expect(verdict(f!.candidates, () => false), t.id + ' ' + f!.candidates.slice(0, 2).map((c) => c.id + ':' + c.score.toFixed(2)).join(' ')).toBe('match');
    }
    const stranger = found.find((p) => p.quad.every((q) => q.y > 1060));
    expect(stranger).toBeTruthy();
    expect(verdict(stranger!.candidates, () => false)).not.toBe('match');
  }, 30000);
});

describe('print sorting in rougher conditions', () => {
  it('copes with a tilted phone, uneven light, glare and blur', () => {
    const photos: Raster[] = [];
    const library = new Map<string, Sig>();
    for (let i = 0; i < 60; i++) {
      const p = i % 4 === 0 ? fakePhoto(500 + i, 270, 360) : fakePhoto(500 + i, 360, 270);
      photos.push(p);
      library.set(`p${i}`, makeSig(p));
    }
    const W = 1600, H = 1200;
    const scene = table(W, H, 11);
    // Keystone: the far (top) edge of the table looks narrower.
    const tilt = (p: Pt): Pt => {
      const k = 0.78 + 0.22 * (p.y / H);
      return { x: W / 2 + (p.x - W / 2) * k, y: 80 + p.y * 0.9 };
    };
    const picks = [4, 9, 17, 26, 33, 41, 48, 55];
    const truth: { id: string; c: Pt }[] = [];
    picks.forEach((idx, n) => {
      const c = { x: 230 + (n % 4) * 380, y: 300 + Math.floor(n / 4) * 560 };
      const print = toPrint(photos[idx], 300 + n);
      const [pw, ph] = print.w >= print.h ? [300, 200] : [200, 300];
      const corners = rotatedRect(c.x, c.y, pw, ph, (n * 0.37) % 0.6 - 0.3 + (n % 3 === 1 ? Math.PI / 2 : 0)).map(tilt);
      paste(scene, print, corners);
      truth.push({ id: `p${idx}`, c: tilt(c) });
    });
    // Light falls off across the table, a glare spot sits on one print, and the shot is a little soft.
    const g = truth[1].c;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const light = 0.75 + 0.35 * (x / W);
      const glare = Math.exp(-((x - g.x - 30) ** 2 + (y - g.y + 10) ** 2) / (2 * 28 ** 2)) * 160;
      for (let k = 0; k < 3; k++) scene.data[i + k] = scene.data[i + k] * light + glare;
    }
    const soft = new Uint8ClampedArray(scene.data);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let k = 0; k < 3; k++) {
      const i = (y * W + x) * 4 + k;
      scene.data[i] = (soft[i] * 4 + soft[i - 4] + soft[i + 4] + soft[i - W * 4] + soft[i + W * 4]) / 8;
    }

    const found = analyzeTable(scene, library);
    expect(found.length).toBe(picks.length);
    for (const t of truth) {
      const f = found.find((p) => Math.hypot(p.quad.reduce((s, q) => s + q.x, 0) / 4 - t.c.x, p.quad.reduce((s, q) => s + q.y, 0) / 4 - t.c.y) < 60);
      expect(f, `print ${t.id} detected`).toBeTruthy();
      expect(f!.candidates[0].id, `print ${t.id} matched`).toBe(t.id);
      expect(verdict(f!.candidates, () => false), `print ${t.id} confident`).toBe('match');
    }
  }, 30000);
});

describe('a big batch', () => {
  it('sorts 40 prints in one photo, some touching or overlapping', () => {
    const library = new Map<string, Sig>();
    const photos: Raster[] = [];
    for (let i = 0; i < 90; i++) {
      const p = i % 5 === 0 ? fakePhoto(2000 + i, 240, 320) : fakePhoto(2000 + i, 320, 240);
      photos.push(p);
      library.set(`p${i}`, makeSig(p));
    }
    const W = 2000, H = 1500;
    const scene = table(W, H, 21);
    const r = rng(77);
    const truth: { id: string; c: Pt; contact: boolean }[] = [];
    // 8 columns x 5 rows; a few neighbours pushed together to touch or overlap.
    const touchPairs = new Map([[2, 0], [11, 0], [20, 0], [29, 0], [33, 0.12], [14, 0.1]]); // index -> overlap fraction
    for (let n = 0; n < 40; n++) {
      const col = n % 8, row = Math.floor(n / 8);
      const idx = (n * 7 + 3) % 90;
      const print = toPrint(photos[idx], 900 + n);
      const land = print.w >= print.h;
      const [pw, ph] = land ? [210, 140] : [140, 210];
      let cx = 130 + col * 248 + (r() - 0.5) * 20, cy = 160 + row * 290 + (r() - 0.5) * 20;
      let angle = (r() - 0.5) * 0.2;
      let contact = false;
      const prev = truth[n - 1];
      if (touchPairs.has(n - 1) && col > 0 && prev) {
        // Butt this print up against the previous one (same row), level with it.
        const ov = touchPairs.get(n - 1)!;
        const prevW = truth[n - 1] ? (photos[(((n - 1) * 7 + 3) % 90)].w >= photos[(((n - 1) * 7 + 3) % 90)].h ? 210 : 140) : 210;
        cx = prev.c.x + prevW / 2 + pw / 2 - ov * pw;
        cy = prev.c.y + (ph - (land ? 140 : 210)) / 2;
        angle = 0;
        contact = true;
        prev.contact = true;
      }
      paste(scene, print, rotatedRect(cx, cy, pw, ph, angle));
      truth.push({ id: `p${idx}`, c: { x: cx, y: cy }, contact });
    }
    const found = analyzeTable(scene, library);
    let correct = 0, wrongConfident = 0;
    const misses: string[] = [];
    for (const t of truth) {
      const f = found.find((p) => Math.hypot(p.quad.reduce((s, q) => s + q.x, 0) / 4 - t.c.x, p.quad.reduce((s, q) => s + q.y, 0) / 4 - t.c.y) < 50);
      const v = f ? verdict(f.candidates, () => false) : 'none';
      if (f && v === 'match' && f.candidates[0].id === t.id) correct++;
      else {
        misses.push(`${t.id}${t.contact ? '(touching)' : ''}:${f ? `${f.candidates[0].id}/${f.candidates[0].score.toFixed(2)}/${v}` : 'not found'}`);
        if (f && v === 'match') wrongConfident++;
      }
    }
    expect(wrongConfident, misses.join(' ')).toBe(0);
    expect(correct, misses.join(' ')).toBeGreaterThanOrEqual(36);
  }, 60000);
});

/** Soft, low-contrast photos in skin, beige and brown tones: the hardest case on a wood floor. */
function warmPhoto(seed: number, w: number, h: number): Raster {
  const r = rng(seed);
  const warm = [[236, 200, 170], [224, 180, 150], [200, 150, 120], [250, 235, 215], [180, 200, 225], [150, 120, 95], [240, 220, 200], [205, 170, 140], [120, 150, 190], [90, 70, 60]];
  const pick = () => warm[Math.floor(r() * warm.length)].map((v) => Math.max(0, Math.min(255, v + (r() - 0.5) * 50)));
  const bg = pick();
  const shapes = Array.from({ length: 7 }, () => ({ x: r() * w, y: r() * h, rx: (0.08 + r() * 0.3) * w, ry: (0.08 + r() * 0.3) * h, c: pick(), box: r() < 0.5 }));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let px = bg;
    for (const s of shapes) {
      const inside = s.box ? Math.abs(x - s.x) < s.rx && Math.abs(y - s.y) < s.ry : ((x - s.x) / s.rx) ** 2 + ((y - s.y) / s.ry) ** 2 < 1;
      if (inside) px = s.c;
    }
    data.set([...px, 255], (y * w + x) * 4);
  }
  // Soften like a phone photo of a soft scene.
  const out = new Uint8ClampedArray(data);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) for (let k = 0; k < 3; k++) {
    let s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += data[((y + dy) * w + x + dx) * 4 + k];
    out[(y * w + x) * 4 + k] = s / 25;
  }
  return { w, h, data: out };
}

/** Wood planks: several tones, grain, and dark seams between boards. */
function plankFloor(w: number, h: number, seed: number): Raster {
  const r = rng(seed);
  const tones = [[176, 128, 86], [160, 112, 72], [188, 140, 96], [150, 104, 66]];
  const pw = Math.round(h / 11.6);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const plank = Math.floor(y / pw), t = tones[plank % 4], off = (plank * 977) % w;
    for (let x = 0; x < w; x++) {
      const grain = Math.sin((x + off) * 0.02 + Math.sin(y * 0.1 + plank) * 2) * 10 + (r() - 0.5) * 12;
      const seam = y % pw < 2 ? 0.55 : 1;
      data.set([(t[0] + grain) * seam, (t[1] + grain * 0.75) * seam, (t[2] + grain * 0.55) * seam, 255], (y * w + x) * 4);
    }
  }
  return { w, h, data };
}

describe('a wooden floor', () => {
  it('sorts 30 warm-toned prints laid on planks without wrong matches', () => {
    const library = new Map<string, Sig>();
    const photos: Raster[] = [];
    for (let i = 0; i < 60; i++) {
      const p = i % 4 === 0 ? warmPhoto(3000 + i, 216, 288) : warmPhoto(3000 + i, 288, 216);
      photos.push(p);
      library.set(`p${i}`, makeSig(p));
    }
    const W = 2000, H = 1500;
    const scene = plankFloor(W, H, 9);
    const r = rng(31);
    const truth: { id: string; c: Pt }[] = [];
    for (let n = 0; n < 30; n++) {
      const idx = (n * 13 + 5) % 60;
      const print = toPrint(photos[idx], 4000 + n);
      const [pw, ph] = print.w >= print.h ? [270, 180] : [180, 270];
      const c = { x: 190 + (n % 6) * 325 + (r() - 0.5) * 30, y: 165 + Math.floor(n / 6) * 292 + (r() - 0.5) * 24 };
      paste(scene, print, rotatedRect(c.x, c.y, pw, ph, (r() - 0.5) * 0.35));
      truth.push({ id: `p${idx}`, c });
    }
    const found = analyzeTable(scene, library);
    const decisions = batchVerdicts(found.map((f) => f.candidates), () => false);
    let correct = 0, wrong = 0;
    const notes: string[] = [];
    for (const t of truth) {
      const k = found.findIndex((p) => Math.hypot(p.quad.reduce((s, q) => s + q.x, 0) / 4 - t.c.x, p.quad.reduce((s, q) => s + q.y, 0) / 4 - t.c.y) < 60);
      if (k < 0) { notes.push(`${t.id}: not found`); continue; }
      const d = decisions[k];
      if (d.verdict === 'match' && d.id === t.id) correct++;
      else if (d.verdict === 'match') { wrong++; notes.push(`${t.id}: WRONG ${d.id}`); }
      else notes.push(`${t.id}: ${d.verdict}`);
    }
    expect(wrong, notes.join(', ')).toBe(0);
    expect(correct, notes.join(', ')).toBeGreaterThanOrEqual(26);
  }, 60000);
});

describe('prints packed tightly', () => {
  it('separates ~60 prints laid in rows with hairline gaps', () => {
    const library = new Map<string, Sig>();
    const photos: Raster[] = [];
    for (let i = 0; i < 90; i++) {
      const p = fakePhoto(5000 + i, 300, 225);
      photos.push(p);
      library.set(`p${i}`, makeSig(p));
    }
    // Portrait shot of the floor, like holding the phone upright over a long layout.
    const W = 1500, H = 2000;
    const scene = plankFloor(W, H, 4);
    const r = rng(8);
    const truth: { id: string; c: Pt }[] = [];
    const pw = 240, ph = 160;
    for (let row = 0; row < 11; row++) for (let col = 0; col < 5; col++) {
      const n = row * 5 + col, idx = (n * 11 + 7) % 90;
      // Gaps of only a few pixels; some neighbours touch.
      const gapX = (n % 4 === 0) ? 0 : 4 + r() * 6, gapY = (n % 7 === 0) ? 0 : 3 + r() * 5;
      const c = { x: 160 + col * (pw + 30) + gapX, y: 140 + row * (ph + 8) + gapY };
      paste(scene, toPrint(photos[idx], 6000 + n), rotatedRect(c.x, c.y, pw, ph, (r() - 0.5) * 0.04));
      truth.push({ id: `p${idx}`, c });
    }
    const found = analyzeTable(scene, library);
    const decisions = batchVerdicts(found.map((f) => f.candidates), () => false);
    let correct = 0, wrong = 0;
    for (const t of truth) {
      const k = found.findIndex((p) => Math.hypot(p.quad.reduce((s, q) => s + q.x, 0) / 4 - t.c.x, p.quad.reduce((s, q) => s + q.y, 0) / 4 - t.c.y) < 40);
      if (k < 0) continue;
      if (decisions[k].verdict === 'match') { if (decisions[k].id === t.id) correct++; else wrong++; }
    }
    expect(wrong).toBe(0);
    expect(correct).toBeGreaterThanOrEqual(48);
  }, 90000);
});
