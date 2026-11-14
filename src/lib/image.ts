// On-device decoding and resizing. Nothing here touches the network.

export const FULL_MAX_EDGE = 3000; // plenty for a 12x12 collage at 300 DPI
export const THUMB_MAX_EDGE = 480;

type Drawable = ImageBitmap | HTMLImageElement;

function sizeOf(src: Drawable) {
  return src instanceof HTMLImageElement ? { w: src.naturalWidth, h: src.naturalHeight } : { w: src.width, h: src.height };
}

export function looksLikeHeic(file: File): boolean {
  return /\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type);
}

function loadViaImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be decoded')); };
    img.src = url;
  });
}

/**
 * Decode any image the browser can read. Safari reads HEIC natively; other
 * browsers fall back to a bundled libheif decoder that is only downloaded the
 * first time a HEIC photo needs it.
 */
export async function decodeImage(file: Blob & { name?: string }): Promise<Drawable> {
  try {
    return await createImageBitmap(file);
  } catch { /* try the next decoder */ }
  try {
    return await loadViaImg(file);
  } catch (err) {
    const heic = file instanceof File ? looksLikeHeic(file) : /hei[cf]/i.test(file.type);
    if (!heic) throw err;
  }
  const { heicTo } = await import('heic-to');
  return heicTo({ blob: file, type: 'bitmap' });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality),
  );
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Free canvas memory right away; iOS has a tight total canvas budget. */
function release(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}

/**
 * Downscale with repeated halving for a cleaner result than one big jump,
 * then JPEG-encode.
 */
export async function resizeToJpeg(src: Drawable | HTMLCanvasElement, maxEdge: number, quality = 0.88): Promise<{ blob: Blob; width: number; height: number }> {
  const { w, h } = src instanceof HTMLCanvasElement ? { w: src.width, h: src.height } : sizeOf(src);
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  let cur: Drawable | HTMLCanvasElement = src;
  let cw = w, ch = h;
  const temps: HTMLCanvasElement[] = [];
  while (cw / 2 > tw && ch / 2 > th) {
    cw = Math.round(cw / 2);
    ch = Math.round(ch / 2);
    const step = makeCanvas(cw, ch);
    const ctx = step.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cw, ch);
    temps.push(step);
    cur = step;
  }
  const out = makeCanvas(tw, th);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; // transparent PNGs/screenshots get a white backing
  ctx.fillRect(0, 0, tw, th);
  ctx.drawImage(cur, 0, 0, tw, th);
  temps.forEach(release);
  const blob = await canvasToBlob(out, quality);
  release(out);
  return { blob, width: tw, height: th };
}

export function imageSize(src: Drawable) {
  return sizeOf(src);
}

export function closeDrawable(src: Drawable) {
  if ('close' in src && typeof src.close === 'function') src.close();
}
