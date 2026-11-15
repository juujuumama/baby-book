import { useEffect, useState } from 'preact/hooks';
import { db, deleteExtraBlob } from './db';
import type { Candidate, Verdict } from './vision/match';
import type { Quad } from './vision/warp';

// Sorting more prints than fit on the floor at once: each floor photo becomes
// a pile (A, B, C...), each pile is stacked in date order, and the piles are
// merged at the end. Saved on the device so it survives closing the app.

export interface Pile {
  id: string;
  label: string;
  /** Matched photo ids in the order they're stacked (earliest on top). */
  photoIds: string[];
  /** Prints that couldn't be matched (set aside). */
  unmatched: number;
  createdAt: number;
  /** Everything found in the floor photo, so the pile can be reopened. */
  results?: SavedPrint[];
  /** The floor photo is stored under photoKey(pile.id). */
  hasPhoto?: boolean;
}

export interface SavedPrint { quad: Quad; candidates: Candidate[]; verdict: Verdict; chosen: string | null; confirmed: boolean }

export const photoKey = (pileId: string) => `pile:${pileId}`;

let piles: Pile[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function persist() {
  await (await db()).put('meta', piles, 'sortSession');
}

export async function loadPiles(): Promise<Pile[]> {
  if (!loaded) {
    piles = ((await (await db()).get('meta', 'sortSession')) as Pile[] | undefined) ?? [];
    loaded = true;
    emit();
  }
  return piles;
}

export function getPile(id: string): Pile | undefined {
  return piles.find((p) => p.id === id);
}

export function usePiles(): Pile[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    loadPiles();
    return () => { listeners.delete(l); };
  }, []);
  return piles;
}

function nextLabel(): string {
  const used = new Set(piles.map((p) => p.label));
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(65 + i); if (!used.has(l)) return l; }
  return String(piles.length + 1);
}

/** Create a pile for a new floor photo; returns its id. */
export async function startPile(): Promise<Pile> {
  await loadPiles();
  const pile: Pile = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label: nextLabel(), photoIds: [], unmatched: 0, createdAt: Date.now() };
  piles = [...piles, pile];
  emit();
  await persist();
  return pile;
}

export async function updatePile(id: string, photoIds: string[], unmatched: number, extra: Partial<Pile> = {}) {
  piles = piles.map((p) => (p.id === id ? { ...p, ...extra, photoIds, unmatched } : p));
  emit();
  await persist();
}

export async function removePile(id: string) {
  piles = piles.filter((p) => p.id !== id);
  deleteExtraBlob(photoKey(id)).catch(() => {});
  emit();
  await persist();
}

export async function clearPiles() {
  for (const p of piles) deleteExtraBlob(photoKey(p.id)).catch(() => {});
  piles = [];
  emit();
  await persist();
}

export interface MergeStep { pile: string; photoId: string; n: number }

/**
 * The combined order: repeatedly take the earliest of the piles' top prints.
 * `takenOf` gives each photo's time taken (ISO-like strings sort by time).
 */
export function mergeOrder(list: Pile[], takenOf: (id: string) => string): MergeStep[] {
  const tops = list.map(() => 0);
  const out: MergeStep[] = [];
  for (;;) {
    let best = -1, bestT = '';
    list.forEach((p, i) => {
      if (tops[i] >= p.photoIds.length) return;
      const t = takenOf(p.photoIds[tops[i]]);
      if (best < 0 || t < bestT) { best = i; bestT = t; }
    });
    if (best < 0) return out;
    out.push({ pile: list[best].label, photoId: list[best].photoIds[tops[best]], n: out.length + 1 });
    tops[best]++;
  }
}
