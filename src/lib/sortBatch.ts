import { putExtraBlob } from './db';
import { byTakenIds, sameMomentFn } from './printLabels';
import { photoKey, updatePile, type Pile, type SavedPrint } from './sortSession';
import type { Photo } from './types';
import { rasterFromFile, rasterToCanvas } from './vision/browser';
import type { Candidate } from './vision/match';
import { matchPrintAt, resolveFloor, type MatchContext } from './vision/matcher';
import { analyzeTable } from './vision/pipeline';
import type { Raster } from './vision/raster';

export const ANALYZE_EDGE = 2000;

/**
 * Sort one floor photo into a pile: find the prints, match them, keep the
 * photo and results on the device so the pile can be reopened, and save the
 * pile's order. Used for a single photo and for several at once.
 */
export async function sortFloorPhoto(
  file: Blob, pile: Pile, ctx: MatchContext, byId: Map<string, Photo>,
  markPrinted: (ids: string[]) => void,
): Promise<{ raster: Raster; results: SavedPrint[] }> {
  const raster = await rasterFromFile(file, ANALYZE_EDGE);
  await new Promise((r) => setTimeout(r, 30)); // let the screen update first
  const analyzed = analyzeTable(raster, new Map());
  const quads = analyzed.map((f) => ({ quad: f.quad, doubtful: f.doubtful }));
  const lists: Candidate[][] = [];
  for (const q of quads) {
    lists.push(matchPrintAt(raster, q.quad, ctx, 6));
    if (lists.length % 5 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the screen responsive
  }
  // Matching also places prints: outlines that were off are replaced by where each photo really is.
  const results: SavedPrint[] = resolveFloor(quads, lists, sameMomentFn(byId)).map((f) => ({
    quad: f.quad, candidates: f.candidates, verdict: f.verdict, chosen: f.chosen, confirmed: false,
  }));
  const blob = await new Promise<Blob | null>((r) => rasterToCanvas(raster).toBlob(r, 'image/jpeg', 0.88));
  if (blob) await putExtraBlob(photoKey(pile.id), blob);
  const matched = results.filter((r) => r.chosen).map((r) => r.chosen!);
  await updatePile(pile.id, byTakenIds(matched, byId), results.length - matched.length, { results, hasPhoto: !!blob });
  if (matched.length) markPrinted(matched);
  return { raster, results };
}
