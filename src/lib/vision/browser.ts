// Browser glue: get pixels out of images and canvases for the vision code.
import { getAllOrbs, getAllSigs, getBlob, putOrb, putSig } from '../db';
import { packOrb, unpackOrb, type Orb } from './orb';
import { photoOrbs } from './matcher';
import { decodeImage, closeDrawable } from '../image';
import type { Photo } from '../types';
import { makeSig, type Sig } from './match';
import { fitSize, type Raster } from './raster';

type Source = CanvasImageSource & ({ width: number; height: number } | HTMLImageElement | HTMLVideoElement);

function sourceSize(src: Source) {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: (src as any).width as number, h: (src as any).height as number };
}

let scratch: HTMLCanvasElement | null = null;

/** Draw any image source into an RGBA raster, at most `maxEdge` on the long side. */
export function rasterFrom(src: Source, maxEdge: number): Raster {
  const { w: sw, h: sh } = sourceSize(src);
  const { w, h } = fitSize(sw, sh, maxEdge);
  scratch ??= document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  scratch.width = 0;
  scratch.height = 0;
  return { w, h, data };
}

export function sigFromSource(src: Source): Sig {
  return makeSig(rasterFrom(src, 192));
}

/** Decode a file (HEIC too) into a raster for analysis. */
export async function rasterFromFile(file: Blob, maxEdge: number): Promise<Raster> {
  const img = await decodeImage(file);
  try {
    return rasterFrom(img as Source, maxEdge);
  } finally {
    closeDrawable(img);
  }
}

export function rasterToCanvas(r: Raster): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = r.w;
  c.height = r.h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
  return c;
}

/**
 * Load every photo's matching data (a small whole-image fingerprint and its
 * feature points), building whatever is missing from the thumbnails. Only
 * slow the first time; everything is kept on the device afterwards.
 */
export async function loadMatchData(photos: Photo[], onProgress?: (done: number, total: number) => void): Promise<{ sigs: Map<string, Sig>; orbs: Map<string, Orb[]> }> {
  const [sigs, packed] = await Promise.all([getAllSigs(), getAllOrbs()]);
  const ids = new Set(photos.map((p) => p.id));
  for (const id of [...sigs.keys()]) if (!ids.has(id)) sigs.delete(id);
  const orbs = new Map<string, Orb[]>();
  for (const [id, p] of packed) if (ids.has(id)) orbs.set(id, p.map(unpackOrb));
  const missing = photos.filter((p) => !sigs.has(p.id) || !orbs.has(p.id));
  let done = 0;
  onProgress?.(done, missing.length);
  for (const p of missing) {
    try {
      const blob = await getBlob(p.id, 'thumb');
      if (blob) {
        const img = await decodeImage(blob);
        const raster = rasterFrom(img as Source, 480);
        closeDrawable(img);
        if (!sigs.has(p.id)) { const sig = makeSig(raster); await putSig(p.id, sig); sigs.set(p.id, sig); }
        if (!orbs.has(p.id)) { const levels = photoOrbs(raster); await putOrb(p.id, levels.map(packOrb)); orbs.set(p.id, levels); }
      }
    } catch (err) {
      console.warn('Could not prepare', p.id, err);
    }
    onProgress?.(++done, missing.length);
    if (done % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { sigs, orbs };
}
