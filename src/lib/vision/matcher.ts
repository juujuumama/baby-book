import { makeSig, rankMatches, verdict, type Candidate, type Sig, type Verdict } from './match';
import { BowIndex, computeOrb, orbInliers, OrbVocab, type Orb } from './orb';
import { fitSize, resizeRaster } from './raster';
import type { Raster } from './raster';

// Matching a print to a photo, in two steps:
//  1. shortlist likely photos: by shared "visual words" (feature-point
//     families) plus the quick whole-image comparison;
//  2. verify each by counting feature points that line up consistently.

/**
 * Feature points only match at similar scales, and a print on the floor can be
 * anywhere from ~90 to ~400 pixels across. So each photo keeps feature points
 * at several sizes, and a print is compared at the size nearest its own.
 */
export const ORB_LEVELS = [110, 160, 230, 320];
export const ORB_LEVEL_POINTS = [120, 170, 220, 250];

interface Level { edge: number; orbs: Map<string, Orb>; bow: BowIndex | null }
export interface MatchContext { sigs: Map<string, Sig>; levels: Level[] }

/** Feature points for a photo (from its thumbnail) at every level. */
export function photoOrbs(thumb: Raster): Orb[] {
  return ORB_LEVELS.map((edge, i) => {
    const t = fitSize(thumb.w, thumb.h, edge);
    return computeOrb(t.scale < 1 ? resizeRaster(thumb, t.w, t.h) : thumb, ORB_LEVEL_POINTS[i]);
  });
}

export function buildContext(sigs: Map<string, Sig>, orbs: Map<string, Orb[]>): MatchContext {
  // One vocabulary (trained on a middle level) serves all levels.
  const mid = [...orbs.values()].map((l) => l[2]).filter((o) => o && o.n > 0);
  const vocab = mid.length >= 10 ? OrbVocab.train(mid) : null;
  const levels = ORB_LEVELS.map((edge, li) => {
    const m = new Map<string, Orb>();
    for (const [id, l] of orbs) if (l[li]) m.set(id, l[li]);
    return { edge, orbs: m, bow: vocab && m.size ? new BowIndex(vocab, m) : null };
  });
  return { sigs, levels };
}

const SHORTLIST_BOW = 40, SHORTLIST_NCC = 10;

/** Ranked candidates for one straightened print. */
export function matchPrint(image: Raster, ctx: MatchContext, top = 5): Candidate[] {
  const ncc = rankMatches(makeSig(image), ctx.sigs, SHORTLIST_NCC);
  // Pick the level nearest the print's own size and bring the print to exactly that size.
  const size = Math.max(image.w, image.h);
  let li = ORB_LEVELS.findIndex((L) => L >= size * 0.95);
  if (li < 0) li = ORB_LEVELS.length - 1;
  const level = ctx.levels[li];
  if (!level?.bow || !level.orbs.size) return ncc.slice(0, top);
  const k = level.edge / size;
  const q = computeOrb(resizeRaster(image, Math.max(8, Math.round(image.w * k)), Math.max(8, Math.round(image.h * k))), 400);
  const ids = new Set<string>([...level.bow.shortlist(q, SHORTLIST_BOW), ...ncc.map((c) => c.id)]);
  const nccScore = new Map(ncc.map((c) => [c.id, c.score]));
  const out: Candidate[] = [];
  for (const id of ids) {
    const o = level.orbs.get(id);
    const inl = o ? orbInliers(q, o) : 0;
    out.push({ id, inliers: inl, score: inl / (inl + 20) });
  }
  out.sort((a, b) => (b.inliers! - a.inliers!) || ((nccScore.get(b.id) ?? 0) - (nccScore.get(a.id) ?? 0)));
  return out.slice(0, top);
}

/**
 * How sure we are, from feature-point agreement: a real match lines up dozens
 * of points, lookalikes rarely more than ~20. Falls back to "unsure" at best
 * when feature points weren't available.
 */
export function orbVerdict(c: Candidate[], sameMoment: (a: string, b: string) => boolean): Verdict {
  const [a, b] = c;
  if (!a) return 'none';
  if (a.inliers === undefined) { const v = verdict(c, sameMoment); return v === 'match' ? 'unsure' : v; }
  const second = b?.inliers ?? 0;
  if (a.inliers >= 22 && (a.inliers >= second * 2.5 || (b && sameMoment(a.id, b.id) && a.inliers >= second * 1.3))) return 'match';
  if (a.inliers >= 10) return 'unsure';
  return 'none';
}
