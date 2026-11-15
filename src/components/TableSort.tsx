import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { saveFiles } from '../lib/backup';
import { byTakenIds, fullLabel, shortLabel, type PrintInfo } from '../lib/printLabels';
import { rasterFromFile, rasterToCanvas } from '../lib/vision/browser';
import { type Candidate, type Sig, type Verdict } from '../lib/vision/match';
import { printSig, straighten } from '../lib/vision/pipeline';
import { colorGradient, fitPrintAt, neighbourShape, type Grad } from '../lib/vision/fitAt';
import { rankMatches } from '../lib/vision/match';
import type { Raster } from '../lib/vision/raster';
import type { Pt, Quad } from '../lib/vision/warp';
import { patchPhotos, useStore } from '../store';
import { OrderWalk } from './OrderWalk';
import { getPile, photoKey, removePile, updatePile, type Pile } from '../lib/sortSession';
import { getExtraBlob } from '../lib/db';
import { ANALYZE_EDGE, sortFloorPhoto } from '../lib/sortBatch';
import { Sheet } from './Sheet';
import { Thumb } from './Thumb';

interface Found {
  quad: Quad;
  print: string; // data URL of the straightened print
  candidates: Candidate[];
  verdict: Verdict;
  /** The photo it is (auto or chosen); null = not matched. */
  chosen: string | null;
  confirmed: boolean;
}


function centroid(q: Quad): Pt {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}

function inQuad(p: Pt, q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
}

function quadSize(q: Quad) {
  return Math.sqrt(Math.abs(((q[2].x - q[0].x) * (q[3].y - q[1].y) - (q[3].x - q[1].x) * (q[2].y - q[0].y)) / 2));
}

export function TableSort({ file, pile, sigs, positions, onDone, onAnother, inputs }: {
  /** A new floor photo to analyse, or null to reopen a saved pile. */
  file: File | null; pile: Pile; sigs: Map<string, Sig>; positions: Map<string, PrintInfo>;
  onDone: () => void; onAnother: () => void; inputs: ComponentChildren;
}) {
  const { photos } = useStore();
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const [base, setBase] = useState<HTMLCanvasElement | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [zoom, setZoom] = useState(false);
  const [walking, setWalking] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rasterRef = useRef<Raster | null>(null);
  const gradRef = useRef<Grad | null>(null);
  const [adding, setAdding] = useState(false);

  const [runId, setRunId] = useState(0);
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    let live = true;
    setFound(null); setBase(null); setError(null);
    (async () => {
      try {
        // A new photo, or the pile's saved one.
        const saved = !file ? await getExtraBlob(photoKey(pile.id)) : null;
        if (!file && !saved) {
          setError("This pile was made before piles could be reopened. Remove it and take that floor photo again.");
          return;
        }
        const raster: Raster = await rasterFromFile(file ?? saved!, ANALYZE_EDGE);
        if (!live) return;
        rasterRef.current = raster;
        gradRef.current = null;
        const canvasImg = rasterToCanvas(raster);
        setBase(canvasImg);
        const prior = getPile(pile.id)?.results;
        if (!file && prior && runId === 0) {
          // Reopen exactly as it was left, corrections included.
          setReopened(true);
          setFound(prior.map((r) => ({ ...r, print: rasterToCanvas(straighten(raster, r.quad)).toDataURL('image/jpeg', 0.85) })));
          return;
        }
        const { results } = await sortFloorPhoto(file ?? saved!, pile, sigs, byId, (ids) => patchPhotos(ids, { printed: true }));
        if (!live) return;
        setFound(results.map((r) => ({ ...r, print: rasterToCanvas(straighten(raster, r.quad)).toDataURL('image/jpeg', 0.85) })));
      } catch (err) {
        console.warn(err);
        if (live) setError("Couldn't read that photo. Try taking it again.");
      }
    })();
    return () => { live = false; };
  }, [file, runId]);

  // Order: matched prints by time taken get 1, 2, 3…; others get "?".
  const order = useMemo(() => {
    const m = new Map<number, number>();
    if (!found) return m;
    const ids = byTakenIds(found.filter((f) => f.chosen).map((f) => f.chosen!), byId);
    found.forEach((f, i) => { if (f.chosen) m.set(i, ids.indexOf(f.chosen) + 1); });
    return m;
  }, [found, byId]);

  useEffect(() => { draw(); }, [base, found, order, open]);

  function draw() {
    const c = canvas.current;
    if (!c || !base) return;
    c.width = base.width;
    c.height = base.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(base, 0, 0);
    if (!found) return;
    const unit = Math.max(c.width, c.height) / 1000;
    found.forEach((f, i) => {
      const n = order.get(i);
      const ok = n !== undefined;
      const s = quadSize(f.quad);
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.beginPath();
      f.quad.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.lineWidth = 7 * unit;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      ctx.lineWidth = 3.5 * unit;
      ctx.strokeStyle = ok ? '#2f4466' : '#e0894f';
      if (!ok) ctx.setLineDash([10 * unit, 7 * unit]);
      ctx.stroke();
      ctx.setLineDash([]);

      const c0 = centroid(f.quad);
      const r = Math.max(16 * unit, Math.min(s * 0.17, 60 * unit));
      ctx.beginPath();
      ctx.arc(c0.x, c0.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ok ? '#2f4466' : '#e0894f';
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 8 * unit;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3 * unit;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${r * 1.1}px "Nunito Variable", system-ui, sans-serif`;
      ctx.fillText(ok ? String(n) : '?', c0.x, c0.y + r * 0.05);

      const info = f.chosen ? positions.get(f.chosen) : null;
      const label = info ? shortLabel(info) : ok ? 'no date' : f.verdict === 'unsure' ? 'tap to check' : 'not found';
      ctx.font = `800 ${Math.max(11 * unit, r * 0.5)}px "Nunito Variable", system-ui, sans-serif`;
      const tw = ctx.measureText(label).width, ph = Math.max(11 * unit, r * 0.5) * 1.6;
      const lx = c0.x - tw / 2 - ph * 0.4, ly = c0.y + r + 6 * unit;
      ctx.fillStyle = 'rgba(255,250,243,0.95)';
      roundRect(ctx, lx, ly, tw + ph * 0.8, ph, ph / 2);
      ctx.fill();
      ctx.fillStyle = '#2f4466';
      ctx.fillText(label, c0.x, ly + ph / 2 + unit);
      ctx.restore();
    });
  }

  function onCanvasClick(e: MouseEvent) {
    const c = canvas.current;
    if (!c || !found) return;
    const rect = c.getBoundingClientRect();
    const p = { x: ((e.clientX - rect.left) / rect.width) * c.width, y: ((e.clientY - rect.top) / rect.height) * c.height };
    const i = found.findIndex((f) => inQuad(p, f.quad));
    if (i >= 0) { setOpen(i); return; }
    addPrintAt(p);
  }

  /** The user tapped a print the detector missed: fit an outline there and match it. */
  async function addPrintAt(p: Pt) {
    const raster = rasterRef.current;
    if (!raster || !found || adding) return;
    const shape = neighbourShape(found.map((f) => f.quad), p);
    if (!shape) return;
    setAdding(true);
    await new Promise((r) => setTimeout(r, 30));
    try {
      gradRef.current ??= colorGradient(raster);
      const quad = fitPrintAt(gradRef.current, p, shape);
      const { image, sig } = printSig(raster, quad);
      const candidates = rankMatches(sig, sigs);
      const next: Found = { quad, print: rasterToCanvas(image).toDataURL('image/jpeg', 0.85), candidates, verdict: 'unsure', chosen: null, confirmed: false };
      setFound([...found, next]);
      setOpen(found.length);
    } finally {
      setAdding(false);
    }
  }

  function removeOutline(i: number) {
    if (!found) return;
    setFound(found.filter((_, k) => k !== i));
    setOpen(null);
  }

  function choose(i: number, id: string | null) {
    if (!found) return;
    const next = found.map((f, k) => (k === i ? { ...f, chosen: id, confirmed: true } : f));
    setFound(next);
    if (id) patchPhotos([id], { printed: true });
    setOpen(null);
  }

  async function saveImage() {
    const c = canvas.current;
    if (!c) return;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (blob) await saveFiles([new File([blob], 'sorted-prints.jpg', { type: 'image/jpeg' })]);
  }

  const sorted = found ? found.map((f, i) => ({ f, i })).filter(({ i }) => order.has(i)).sort((a, b) => order.get(a.i)! - order.get(b.i)!) : [];
  const flagged = found ? found.map((f, i) => ({ f, i })).filter(({ i }) => !order.has(i)) : [];

  // Keep this floor photo's pile up to date (including any corrections).
  const pileKey = found ? found.map((f) => `${f.chosen}:${f.confirmed ? 1 : 0}`).join(',') : '';
  useEffect(() => {
    if (!found) return;
    if (found.length === 0 && file) { removePile(pile.id); return; }
    updatePile(pile.id, sorted.map(({ f }) => f.chosen!), flagged.length, {
      results: found.map(({ quad, candidates, verdict, chosen, confirmed }) => ({ quad, candidates, verdict, chosen, confirmed })),
    });
  }, [pileKey]);

  return (
    <div class="table-sort">
      <div class="row between">
        <button class="btn small ghost" onClick={onDone}>‹ Back</button>
        {found && <span class="muted small">Pile {pile.label} · {found.length} prints found</span>}
        {found && found.length > 0 && <button class="btn small" onClick={() => setZoom(!zoom)}>{zoom ? 'Fit' : 'Zoom'}</button>}
      </div>
      {reopened && found && (
        <div class="row reopen-row">
          <span class="muted small">Reopened as you left it.</span>
          <button class="btn small" onClick={() => { if (confirm('Look at this floor photo again with the latest matching? Any matches you picked by hand will be redone.')) { setReopened(false); setRunId((n) => n + 1); } }}>Run again</button>
        </div>
      )}

      <div class={`table-photo ${zoom ? 'zoomed' : ''}`}>
        {base ? <canvas ref={canvas} onClick={onCanvasClick} /> : <div class="table-placeholder">Opening photo…</div>}
        {base && !found && !error && <div class="table-busy"><span>Looking for prints…</span></div>}
        {adding && <div class="table-busy"><span>Adding that print…</span></div>}
      </div>
      {error && <p class="card">{error}</p>}

      {found && found.length === 0 && (
        <div class="card">
          <h3>No prints found</h3>
          <p class="muted">Try a darker, plain surface, leave space between prints, and hold the phone straight above them.</p>
        </div>
      )}

      {found && found.length >= 4 && sorted.length < found.length * 0.3 && (
        <div class="card warn-card">
          <h3>Most prints didn't match</h3>
          <p>Only {sorted.length} of {found.length} prints matched a photo in your book. Usually this means the camera-roll photos for these months haven't been added yet. Your book has {photos.length} {photos.length === 1 ? 'photo' : 'photos'}.</p>
          <p class="muted small">Add them from the Months tab, then come back and choose this same picture again.</p>
        </div>
      )}
      {found && found.length > 0 && (
        <>
          <button class="btn primary block walk-start" onClick={() => setWalking(true)}>Go through in order ›</button>
          <p class="muted small center">Swipe through the prints one by one, putting each one on top of the last. When you're done, flip the stack over so #1 is on top: that's <strong>pile {pile.label}</strong>. Tap a print above to check its match, or tap a print with no outline to add it.</p>
          {flagged.length > 0 && (
            <section class="card flagged">
              <h3>Needs a look ({flagged.length})</h3>
              <p class="muted small">These couldn't be matched for sure. Tap to pick the right photo, or set aside.</p>
              <div class="print-rows">
                {flagged.map(({ f, i }) => (
                  <button key={i} class="print-row" onClick={() => setOpen(i)}>
                    <span class="bubble warn">?</span>
                    <img class="print-img" src={f.print} alt="" />
                    <span class="print-text">{f.confirmed ? 'Set aside: not in your photos' : f.verdict === 'unsure' ? 'Not sure, tap to choose' : "Couldn't find this one"}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section class="card">
            <h3>In order</h3>
            <div class="print-rows">
              {sorted.map(({ f, i }) => {
                const info = positions.get(f.chosen!);
                const photo = byId.get(f.chosen!);
                return (
                  <button key={i} class="print-row" onClick={() => setOpen(i)}>
                    <span class="bubble">{order.get(i)}</span>
                    <img class="print-img" src={f.print} alt="" />
                    <span class="print-text">{info ? fullLabel(info) : 'No date yet'}</span>
                    {photo && <span class="print-match"><Thumb photo={photo} /></span>}
                  </button>
                );
              })}
            </div>
          </section>
          <div class="row center-row">
            <button class="btn primary" onClick={onAnother}>Next floor photo (pile {String.fromCharCode(pile.label.charCodeAt(0) + 1)})</button>
            <button class="btn" onClick={onDone}>Done: see all piles</button>
            <button class="btn" onClick={saveImage}>Save numbered photo</button>
          </div>
        </>
      )}

      {walking && base && found && (
        <OrderWalk base={base} positions={positions} byId={byId} total={sorted.length} pileLabel={pile.label}
          steps={[...sorted.map(({ f, i }) => ({ quad: f.quad, print: f.print, n: order.get(i)!, photoId: f.chosen, index: i })),
            ...flagged.map(({ f, i }) => ({ quad: f.quad, print: f.print, n: null, photoId: null, index: i }))]}
          onClose={() => setWalking(false)} onFix={(i) => setOpen(i)} />
      )}
      {open !== null && found && (
        <PrintDetail f={found[open]} positions={positions} byId={byId} onChoose={(id) => choose(open, id)} onClose={() => setOpen(null)} onRemove={() => removeOutline(open)} />
      )}
      {inputs}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function PrintDetail({ f, positions, byId, onChoose, onClose, onRemove }: {
  f: { print: string; candidates: Candidate[]; chosen: string | null };
  positions: Map<string, PrintInfo>; byId: Map<string, import('../lib/types').Photo>;
  onChoose: (id: string | null) => void; onClose: () => void; onRemove?: () => void;
}) {
  return (
    <Sheet title="Which photo is this?" onClose={onClose}>
      <div class="detail-print"><img src={f.print} alt="The print" /></div>
      <p class="muted small center">Best matches, most likely first</p>
      <div class="cand-grid">
        {f.candidates.map((c) => {
          const photo = byId.get(c.id);
          const info = positions.get(c.id);
          if (!photo) return null;
          return (
            <button key={c.id} class={`cand ${f.chosen === c.id ? 'on' : ''}`} onClick={() => onChoose(c.id)}>
              <Thumb photo={photo} />
              <span class="cand-label">{info ? fullLabel(info) : 'No date'}</span>
              <span class="cand-score">{Math.round(Math.max(0, c.score) * 100)}% match</span>
            </button>
          );
        })}
      </div>
      <div class="row end">
        {onRemove && <button class="btn ghost small" onClick={onRemove}>Not a print: remove outline</button>}
        <button class="btn ghost" onClick={() => onChoose(null)}>Not in my photos</button>
      </div>
    </Sheet>
  );
}
