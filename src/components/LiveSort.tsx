import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ageShort, formatShort } from '../lib/dates';
import { byTakenIds, sameMomentFn, type PrintInfo } from '../lib/printLabels';
import { rasterFrom, rasterToCanvas } from '../lib/vision/browser';
import { detectPrints } from '../lib/vision/detect';
import { rankMatches, verdict, type Candidate, type Sig } from '../lib/vision/match';
import { printSig } from '../lib/vision/pipeline';
import type { Quad } from '../lib/vision/warp';
import { patchPhotos, useStore } from '../store';
import { PrintDetail } from './TableSort';
import { Thumb } from './Thumb';

const FRAME_EDGE = 720;

interface Result { id: string | null; candidates: Candidate[]; print: string; sure: boolean }

/** The guide frame: a 4x6 shape centred in the view, turned to match the screen. */
function guideQuad(w: number, h: number, landscape: boolean): Quad {
  const aspect = landscape ? 1.5 : 1 / 1.5;
  let gw = w * 0.78, gh = gw / aspect;
  if (gh > h * 0.78) { gh = h * 0.78; gw = gh * aspect; }
  const x0 = (w - gw) / 2, y0 = (h - gh) / 2;
  return [{ x: x0, y: y0 }, { x: x0 + gw, y: y0 }, { x: x0 + gw, y: y0 + gh }, { x: x0, y: y0 + gh }];
}

export function LiveSort({ sigs, positions, onClose }: { sigs: Map<string, Sig>; positions: Map<string, PrintInfo>; onClose: () => void }) {
  const { photos } = useStore();
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [landscape, setLandscapeState] = useState(true);
  const landscapeRef = useRef(true);
  const setLandscape = (v: boolean) => { landscapeRef.current = v; setLandscapeState(v); };
  const [quad, setQuad] = useState<{ q: Quad; w: number; h: number; found: boolean } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [session, setSession] = useState<string[]>([]);
  const [showOrder, setShowOrder] = useState(false);
  const [checking, setChecking] = useState(false);
  const last = useRef<string | null>(null);
  const paused = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const same = sameMomentFn(byId);
        const tick = () => {
          if (stopped) return;
          if (!paused.current && v.videoWidth) analyze(v, same);
          timer = window.setTimeout(tick, 280);
        };
        tick();
      } catch (err) {
        console.warn(err);
        setError('The camera is not available. Allow camera access for Baby Book in Settings, or use "A whole batch" with a photo instead.');
      }
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  function analyze(v: HTMLVideoElement, same: (a: string, b: string) => boolean) {
    const frame = rasterFrom(v, FRAME_EDGE);
    const guide = guideQuad(frame.w, frame.h, landscapeRef.current);
    const gArea = (guide[1].x - guide[0].x) * (guide[3].y - guide[0].y);
    // Prefer a detected print near the guide; otherwise trust the guide frame.
    const dets = detectPrints(frame, { minArea: 0.08 })
      .filter((d) => !d.touchesEdge && d.area > gArea * 0.35)
      .sort((a, b) => b.area - a.area);
    const q = dets[0]?.quad ?? guide;
    setQuad({ q, w: frame.w, h: frame.h, found: !!dets[0] });
    const { image, sig } = printSig(frame, q);
    const candidates = rankMatches(sig, sigs, 5);
    const vd = verdict(candidates, same);
    const top = candidates[0]?.id ?? null;
    if (vd === 'match' && top) {
      // Show a match once two frames in a row agree.
      if (last.current === top) {
        setResult((r) => (r?.id === top ? r : { id: top, candidates, print: rasterToCanvas(image).toDataURL('image/jpeg', 0.8), sure: true }));
        setSession((s) => (s.includes(top) ? s : [...s, top]));
        if (!byId.get(top)?.printed) patchPhotos([top], { printed: true });
      }
      last.current = top;
    } else {
      last.current = null;
      if (vd === 'unsure') setResult((r) => (r?.sure ? r : { id: null, candidates, print: rasterToCanvas(image).toDataURL('image/jpeg', 0.8), sure: false }));
    }
  }

  const info = result?.id ? positions.get(result.id) : null;
  const photo = result?.id ? byId.get(result.id) : null;
  const ordered = byTakenIds(session, byId);

  return (
    <div class="live">
      <div class="live-stage">
        <video ref={video} playsInline muted autoPlay />
        {quad && (
          <svg class="live-overlay" viewBox={`0 0 ${quad.w} ${quad.h}`} preserveAspectRatio="xMidYMid slice">
            <polygon points={quad.q.map((p) => `${p.x},${p.y}`).join(' ')} class={quad.found ? 'found' : 'guide'} />
          </svg>
        )}
        <div class="live-top">
          <button class="icon-btn light" onClick={onClose} aria-label="Close">✕</button>
          <span class="live-hint">{quad?.found ? 'Print found' : 'Hold one print inside the frame'}</span>
          <button class="icon-btn light" onClick={() => setLandscape(!landscape)} aria-label="Turn frame">⟲</button>
        </div>
        {error && <div class="live-error card">{error}</div>}
      </div>

      <div class="live-result">
        {result?.sure && info ? (
          <div class="live-match">
            {photo && <div class="live-thumb"><Thumb photo={photo} /></div>}
            <div>
              <div class="live-age">{ageShort(info.month)} · {formatShort(info.date)}</div>
              <div class="live-num">#{info.index} of {info.total}</div>
            </div>
          </div>
        ) : result?.sure && photo ? (
          <div class="live-match"><div class="live-thumb"><Thumb photo={photo} /></div><div class="live-age">No date yet</div></div>
        ) : result && !result.sure ? (
          <button class="live-unsure" onClick={() => { paused.current = true; setChecking(true); }}>Not sure which photo this is. Tap to choose</button>
        ) : (
          <p class="muted center">Hold up a print…</p>
        )}
        {result?.sure && (
          <button class="btn small ghost" onClick={() => { paused.current = true; setChecking(true); }}>Wrong?</button>
        )}
        {session.length > 0 && (
          <button class="btn small" onClick={() => setShowOrder(!showOrder)}>{showOrder ? 'Hide' : `Sorted so far (${session.length})`}</button>
        )}
      </div>

      {showOrder && (
        <div class="live-order">
          {ordered.map((id, n) => {
            const p = byId.get(id), inf = positions.get(id);
            return p ? (
              <div key={id} class="live-order-item">
                <Thumb photo={p} />
                <span>{n + 1}. {inf ? `${ageShort(inf.month)} · ${formatShort(inf.date)} · #${inf.index}` : 'no date'}</span>
              </div>
            ) : null;
          })}
        </div>
      )}

      {checking && result && (
        <PrintDetail f={{ print: result.print, candidates: result.candidates, chosen: result.id }} positions={positions} byId={byId}
          onClose={() => { setChecking(false); paused.current = false; }}
          onChoose={(id) => {
            setChecking(false);
            paused.current = false;
            if (id) {
              setResult({ ...result, id, sure: true });
              setSession((s) => { const rest = s.filter((x) => x !== result.id && x !== id); return [...rest, id]; });
              patchPhotos([id], { printed: true });
            } else setResult(null);
            last.current = id;
          }} />
      )}
    </div>
  );
}
