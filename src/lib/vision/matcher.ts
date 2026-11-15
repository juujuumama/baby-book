import { makeSig, rankMatches, verdict, type Candidate, type Sig, type Verdict } from './match';
import { BowIndex, computeOrb, orbFit, orbInliers, OrbVocab, type Orb } from './orb';
import { straighten } from './pipeline';
import { applyH, homography, landscapeOrder, type Quad } from './warp';
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

/**
 * Match the print inside `quad` of the floor photo `src`, tolerating an
 * outline that's off by part of a print. Looks at a wider area around the
 * outline, finds which photo's feature points appear there and where, and
 * only counts a photo whose features sit around the outline's centre (not a
 * neighbouring print peeking in).
 */
export function matchPrintAt(src: Raster, quad: Quad, ctx: MatchContext, top = 5): Candidate[] {
  const tight = straighten(src, quad);
  const ncc = rankMatches(makeSig(tight), ctx.sigs, SHORTLIST_NCC);
  const size = Math.max(tight.w, tight.h);
  let li = ORB_LEVELS.findIndex((L) => L >= size * 0.95);
  if (li < 0) li = ORB_LEVELS.length - 1;
  const level = ctx.levels[li];
  if (!level?.bow || !level.orbs.size) return ncc.slice(0, top);

  // The wider area: the outline grown 1.6× about its centre, sized so the
  // print part is exactly this level's size.
  const GROW = 1.6;
  const c = { x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4 };
  const wide = quad.map((p) => ({ x: c.x + (p.x - c.x) * GROW, y: c.y + (p.y - c.y) * GROW })) as Quad;
  const region = straighten(src, wide, level.edge * GROW);
  const q = computeOrb(region, 600);
  const printEdge = Math.max(region.w, region.h) / GROW;
  const cx = region.w / 2, cy = region.h / 2;

  const ids = new Set<string>([...level.bow.shortlist(q, SHORTLIST_BOW), ...ncc.map((x) => x.id)]);
  const nccScore = new Map(ncc.map((x) => [x.id, x.score]));
  // Region pixels → floor-photo pixels (straighten() warps landscapeOrder(wide) onto the region).
  const toFloor = homography([{ x: 0, y: 0 }, { x: region.w, y: 0 }, { x: region.w, y: region.h }, { x: 0, y: region.h }], landscapeOrder(wide));
  const printAspect = Math.max(tight.w, tight.h) / Math.max(1, Math.min(tight.w, tight.h));
  const out: Candidate[] = [];
  for (const id of ids) {
    const o = level.orbs.get(id);
    if (!o) continue;
    const f = orbFit(q, o);
    let eff = 0, at: { x: number; y: number }[] | undefined;
    if (f.inliers > 0) {
      // Where does the photo's centre land, and is it about the right size?
      const P = (x: number, y: number) => ({ x: f.c * x - f.s * y + f.tx, y: f.s * x + f.c * y + f.ty });
      const pc = P(o.w / 2, o.h / 2);
      const d = Math.hypot(pc.x - cx, pc.y - cy) / printEdge;
      const scale = Math.hypot(f.c, f.s) * Math.max(o.w, o.h) / printEdge;
      if (scale > 0.6 && scale < 1.7 && d < 0.65) {
        // Full credit near the centre, fading out towards a neighbour.
        eff = d < 0.35 ? f.inliers : Math.round(f.inliers * (0.65 - d) / 0.3);
        // The print is the photo cropped to the print's shape along its short side.
        const landscape = o.w >= o.h, long = Math.max(o.w, o.h);
        const short = Math.min(Math.min(o.w, o.h), long / printAspect);
        const hw = (landscape ? long : short) / 2, hh = (landscape ? short : long) / 2;
        at = [P(o.w / 2 - hw, o.h / 2 - hh), P(o.w / 2 + hw, o.h / 2 - hh), P(o.w / 2 + hw, o.h / 2 + hh), P(o.w / 2 - hw, o.h / 2 + hh)]
          .map((p) => applyH(toFloor, p.x, p.y));
      }
    }
    out.push({ id, inliers: eff, score: eff / (eff + 20), at, raw: at ? f.inliers : 0 });
  }
  out.sort((a, b) => (b.inliers! - a.inliers!) || ((nccScore.get(b.id) ?? 0) - (nccScore.get(a.id) ?? 0)));
  return out.slice(0, top);
}

export interface FloorPrint { quad: Quad; candidates: Candidate[]; verdict: Verdict; chosen: string | null; doubtful: boolean }

const centreOf = (q: { x: number; y: number }[]) => ({ x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length });
const sizeOf = (q: { x: number; y: number }[]) => Math.sqrt(Math.abs(((q[2].x - q[0].x) * (q[3].y - q[1].y) - (q[3].x - q[1].x) * (q[2].y - q[0].y)) / 2));

/**
 * Match every print on the floor, letting feature points place prints too:
 * a strong match becomes a print at the spot its features point to (with an
 * exact outline), even if the detected outline was off. The same photo found
 * from neighbouring outlines is merged, outlines that turn out to be
 * misplaced are dropped, and whatever's left is kept for the user to check.
 */
export function matchFloor(
  src: Raster, quads: { quad: Quad; doubtful: boolean }[], ctx: MatchContext,
  sameMoment: (a: string, b: string) => boolean,
): FloorPrint[] {
  return resolveFloor(quads, quads.map((q) => matchPrintAt(src, q.quad, ctx, 6)), sameMoment);
}

/** The second half of matchFloor, given each outline's candidates (so callers can compute them with pauses). */
export function resolveFloor(
  quads: { quad: Quad; doubtful: boolean }[], lists: Candidate[][],
  sameMoment: (a: string, b: string) => boolean,
): FloorPrint[] {
  const STRONG = 22;
  // Every strong, located match is a "hit": photo id + where its print lies.
  type Hit = { id: string; inliers: number; at: Quad; from: number };
  const hits: Hit[] = [];
  lists.forEach((l, i) => l.forEach((c) => { if (c.at && (c.raw ?? 0) >= STRONG) hits.push({ id: c.id, inliers: c.raw!, at: c.at as Quad, from: i }); }));
  hits.sort((a, b) => b.inliers - a.inliers);
  // One place per photo, and one photo per place: strongest first.
  const accepted: Hit[] = [];
  const usedIds = new Set<string>();
  for (const h of hits) {
    if (usedIds.has(h.id)) continue;
    const c = centreOf(h.at), s = sizeOf(h.at);
    const clash = accepted.find((a) => Math.hypot(centreOf(a.at).x - c.x, centreOf(a.at).y - c.y) < s * 0.5);
    if (clash) continue;
    accepted.push(h);
    usedIds.add(h.id);
  }
  // Is each accepted hit a clear winner at its spot? (a rival photo placed at the
  // same spot with comparable support means we're not sure which it is)
  const out: FloorPrint[] = accepted.map((h) => {
    const c = centreOf(h.at), s = sizeOf(h.at);
    const rival = hits.filter((o) => o.id !== h.id && Math.hypot(centreOf(o.at).x - c.x, centreOf(o.at).y - c.y) < s * 0.5)
      .reduce((m, o) => Math.max(m, o.inliers), 0);
    const sure = h.inliers >= rival * 2.5 || (rival > 0 && sameMoment(h.id, hits.find((o) => o.inliers === rival && o.id !== h.id)!.id) && h.inliers >= rival * 1.3);
    // Candidates for this spot: from the outline that found it, best first.
    const cands = [...lists[h.from]].sort((a, b) => (a.id === h.id ? -1 : b.id === h.id ? 1 : 0));
    return { quad: h.at, candidates: cands, verdict: sure ? 'match' : 'unsure', chosen: sure ? h.id : null, doubtful: false };
  });
  // Detected outlines not explained by any placed print stay for the user to check.
  const inside = (p: { x: number; y: number }, q: Quad) => {
    let sign = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cr !== 0) { if (sign && Math.sign(cr) !== sign) return false; sign = Math.sign(cr); }
    }
    return true;
  };
  quads.forEach((q, i) => {
    // Mostly covered by prints we've placed? Then it was a misplaced outline.
    let covered = 0, n = 0;
    for (let v = 0.1; v < 1; v += 0.2) for (let u = 0.1; u < 1; u += 0.2) {
      const top = { x: q.quad[0].x + (q.quad[1].x - q.quad[0].x) * u, y: q.quad[0].y + (q.quad[1].y - q.quad[0].y) * u };
      const bot = { x: q.quad[3].x + (q.quad[2].x - q.quad[3].x) * u, y: q.quad[3].y + (q.quad[2].y - q.quad[3].y) * u };
      const p = { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
      n++;
      if (accepted.some((a) => inside(p, a.at))) covered++;
    }
    if (covered / n > 0.45) return;
    const rest = lists[i].filter((x) => !usedIds.has(x.id));
    const v = orbVerdict(rest, sameMoment);
    out.push({ quad: q.quad, candidates: lists[i], verdict: v === 'match' ? 'unsure' : v, chosen: null, doubtful: q.doubtful });
  });
  return out;
}
