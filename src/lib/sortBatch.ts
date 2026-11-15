import { putExtraBlob } from './db';
import { byTakenIds, sameMomentFn } from './printLabels';
import { photoKey, updatePile, type Pile, type SavedPrint } from './sortSession';
import type { Photo } from './types';
import { rasterFromFile, rasterToCanvas } from './vision/browser';
import { batchVerdicts } from './vision/match';
import { matchPrint, orbVerdict, type MatchContext } from './vision/matcher';
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
  const lists: import('./vision/match').Candidate[][] = [];
  for (const f of analyzed) {
    lists.push(matchPrint(f.image, ctx));
    if (lists.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const decisions = batchVerdicts(lists, sameMomentFn(byId), analyzed.map((f) => f.doubtful), orbVerdict);
  const results: SavedPrint[] = analyzed.map((f, i) => ({
    quad: f.quad, candidates: lists[i], verdict: decisions[i].verdict, chosen: decisions[i].id, confirmed: false,
  }));
  const blob = await new Promise<Blob | null>((r) => rasterToCanvas(raster).toBlob(r, 'image/jpeg', 0.88));
  if (blob) await putExtraBlob(photoKey(pile.id), blob);
  const matched = results.filter((r) => r.chosen).map((r) => r.chosen!);
  await updatePile(pile.id, byTakenIds(matched, byId), results.length - matched.length, { results, hasPhoto: !!blob });
  if (matched.length) markPrinted(matched);
  return { raster, results };
}
