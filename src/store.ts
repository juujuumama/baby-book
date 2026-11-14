import { useEffect, useState } from 'preact/hooks';
import * as dbApi from './lib/db';
import type { Photo, Settings } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/types';

// A tiny app-wide store: the photo list and settings, mirrored from IndexedDB.

interface State { ready: boolean; photos: Photo[]; settings: Settings }

let state: State = { ready: false, photos: [], settings: DEFAULT_SETTINGS };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}

export async function loadAll() {
  const [photos, settings] = await Promise.all([dbApi.getAllPhotos(), dbApi.getSettings()]);
  set({ ready: true, photos, settings });
}

export async function reloadPhotos() {
  set({ photos: await dbApi.getAllPhotos() });
}

export async function saveSettings(s: Settings) {
  await dbApi.saveSettings(s);
  set({ settings: s });
}

export async function patchPhoto(id: string, patch: Partial<Photo>) {
  const next = await dbApi.updatePhoto(id, patch);
  if (next) set({ photos: state.photos.map((p) => (p.id === id ? next : p)) });
}

export async function patchPhotos(ids: string[], patch: Partial<Photo>) {
  for (const id of ids) await dbApi.updatePhoto(id, patch);
  const s = new Set(ids);
  set({ photos: state.photos.map((p) => (s.has(p.id) ? { ...p, ...patch } : p)) });
}

export async function removePhotos(ids: string[]) {
  await dbApi.deletePhotos(ids);
  const s = new Set(ids);
  ids.forEach(forgetUrls);
  set({ photos: state.photos.filter((p) => !s.has(p.id)) });
}

export async function wipeEverything() {
  await dbApi.clearEverything();
  urlCache.forEach((u) => URL.revokeObjectURL(u));
  urlCache.clear();
  set({ photos: [], settings: DEFAULT_SETTINGS });
}

// Object URLs for stored images, created on demand and reused.
const urlCache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export function imageUrl(id: string, kind: dbApi.BlobKind): Promise<string | null> {
  const key = `${id}:${kind}`;
  const hit = urlCache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = dbApi.getBlob(id, kind).then((b) => {
      pending.delete(key);
      if (!b) return null;
      const url = URL.createObjectURL(b);
      urlCache.set(key, url);
      // Full-size images are big; keep only a few around.
      if (kind === 'full') trimFull(key);
      return url;
    });
    pending.set(key, p);
  }
  return p;
}

export function cachedUrl(id: string, kind: dbApi.BlobKind): string | null {
  return urlCache.get(`${id}:${kind}`) ?? null;
}

const fullOrder: string[] = [];
function trimFull(key: string) {
  fullOrder.push(key);
  while (fullOrder.length > 6) {
    const old = fullOrder.shift()!;
    const u = urlCache.get(old);
    if (u) URL.revokeObjectURL(u);
    urlCache.delete(old);
  }
}

function forgetUrls(id: string) {
  for (const kind of ['full', 'thumb']) {
    const key = `${id}:${kind}`;
    const u = urlCache.get(key);
    if (u) URL.revokeObjectURL(u);
    urlCache.delete(key);
  }
}
