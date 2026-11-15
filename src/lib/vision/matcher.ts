import { makeSig, rankMatches, verdict, type Candidate, type Sig, type Verdict } from './match';
import { BowIndex, computeOrb, orbInliers, OrbVocab, type Orb } from './orb';
import type { Raster } from './raster';

// Matching a print to a photo, in two steps:
//  1. shortlist likely photos: by shared "visual words" (feature-point
//     families) plus the quick whole-image comparison;
//  2. verify each by counting feature points that line up consistently.

export interface MatchContext { sigs: Map<string, Sig>; orbs: Map<string, Orb>; bow: BowIndex | null }

export function buildContext(sigs: Map<string, Sig>, orbs: Map<string, Orb>): MatchContext {
  const list = [...orbs.values()].filter((o) => o.n > 0);
  const bow = list.length >= 10 ? new BowIndex(OrbVocab.train(list), orbs) : null;
  return { sigs, orbs, bow };
}

const SHORTLIST_BOW = 40, SHORTLIST_NCC = 10;

/** Ranked candidates for one straightened print. */
export function matchPrint(image: Raster, ctx: MatchContext, top = 5): Candidate[] {
  const ncc = rankMatches(makeSig(image), ctx.sigs, SHORTLIST_NCC);
  if (!ctx.bow || !ctx.orbs.size) return ncc.slice(0, top);
  const q = computeOrb(image, 400);
  const ids = new Set<string>([...ctx.bow.shortlist(q, SHORTLIST_BOW), ...ncc.map((c) => c.id)]);
  const nccScore = new Map(ncc.map((c) => [c.id, c.score]));
  const out: Candidate[] = [];
  for (const id of ids) {
    const o = ctx.orbs.get(id);
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
