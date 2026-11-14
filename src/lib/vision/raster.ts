// Plain pixel buffers so the vision code runs anywhere (browser, worker, tests).

export interface Raster { w: number; h: number; data: Uint8ClampedArray } // RGBA
export interface Gray { w: number; h: number; data: Float32Array }

export function toGray(r: Raster): Gray {
  const out = new Float32Array(r.w * r.h);
  const d = r.data;
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { w: r.w, h: r.h, data: out };
}

/** Area-average downscale (or bilinear upscale) of an RGBA raster. */
export function resizeRaster(r: Raster, w: number, h: number): Raster {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = r.w / w, sy = r.h / h;
  if (sx < 1 || sy < 1) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = bilinearRGBA(r, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      out.set(px, (y * w + x) * 4);
    }
    return { w, h, data: out };
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let a = 0, b = 0, c = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < r.h; yy++) {
        let i = (yy * r.w + x0) * 4;
        for (let xx = x0; xx < x1 && xx < r.w; xx++, i += 4) { a += r.data[i]; b += r.data[i + 1]; c += r.data[i + 2]; n++; }
      }
      const o = (y * w + x) * 4;
      out[o] = a / n; out[o + 1] = b / n; out[o + 2] = c / n; out[o + 3] = 255;
    }
  }
  return { w, h, data: out };
}

export function bilinearRGBA(r: Raster, x: number, y: number): [number, number, number, number] {
  x = Math.min(Math.max(x, 0), r.w - 1);
  y = Math.min(Math.max(y, 0), r.h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, r.w - 1), y1 = Math.min(y0 + 1, r.h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * r.w + x0) * 4, i10 = (y0 * r.w + x1) * 4, i01 = (y1 * r.w + x0) * 4, i11 = (y1 * r.w + x1) * 4;
  const d = r.data;
  const out: [number, number, number, number] = [0, 0, 0, 255];
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * fx;
    const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * fx;
    out[c] = top + (bot - top) * fy;
  }
  return out;
}

/** Scale so the long edge is at most `maxEdge`. */
export function fitSize(w: number, h: number, maxEdge: number) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}
