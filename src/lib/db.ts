import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DEFAULT_SETTINGS, type Photo, type Settings } from './types';
import type { Sig } from './vision/match';

interface BabyBookDB extends DBSchema {
  photos: { key: string; value: Photo; indexes: { dedupeKey: string } };
  /** Image data keyed "<photoId>:full" / "<photoId>:thumb". */
  blobs: { key: string; value: Blob | ArrayBuffer };
  meta: { key: string; value: unknown };
  /** Matching fingerprints, keyed by photo id. Rebuilt from thumbnails if missing. */
  sigs: { key: string; value: Sig };
}

export type BlobKind = 'full' | 'thumb';

let dbPromise: Promise<IDBPDatabase<BabyBookDB>> | null = null;

export function db() {
  dbPromise ??= openDB<BabyBookDB>('baby-book', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const photos = d.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('dedupeKey', 'dedupeKey', { unique: false });
        d.createObjectStore('blobs');
        d.createObjectStore('meta');
      }
      if (oldVersion < 2) d.createObjectStore('sigs');
    },
  });
  return dbPromise;
}

export async function getAllPhotos(): Promise<Photo[]> {
  return (await db()).getAll('photos');
}

export async function countPhotos(): Promise<number> {
  return (await db()).count('photos');
}

export async function getPhoto(id: string): Promise<Photo | undefined> {
  return (await db()).get('photos', id);
}

export async function getPhotoByDedupeKey(key: string): Promise<Photo | undefined> {
  return (await db()).getFromIndex('photos', 'dedupeKey', key);
}

export async function hasDedupeKey(key: string): Promise<boolean> {
  return (await (await db()).getKeyFromIndex('photos', 'dedupeKey', key)) !== undefined;
}

// Some Safari builds have refused Blob values in IndexedDB. If that happens we
// fall back to ArrayBuffers for the rest of the session; reads accept both.
let blobsUnsupported = false;

async function putBlob(tx: { objectStore(n: 'blobs'): { put(v: Blob | ArrayBuffer, k: string): Promise<unknown> } }, key: string, blob: Blob) {
  const value = blobsUnsupported ? await blob.arrayBuffer() : blob;
  await tx.objectStore('blobs').put(value, key);
}

export async function savePhoto(photo: Photo, full: Blob, thumb: Blob): Promise<void> {
  const d = await db();
  const write = async () => {
    const tx = d.transaction(['photos', 'blobs'], 'readwrite');
    await Promise.all([
      tx.objectStore('photos').put(photo),
      putBlob(tx as any, `${photo.id}:full`, full),
      putBlob(tx as any, `${photo.id}:thumb`, thumb),
      tx.done,
    ]);
  };
  try {
    await write();
  } catch (err) {
    if (blobsUnsupported || (err as DOMException)?.name === 'QuotaExceededError') throw err;
    blobsUnsupported = true;
    await write();
  }
}

export async function updatePhoto(id: string, patch: Partial<Photo>): Promise<Photo | undefined> {
  const d = await db();
  const tx = d.transaction('photos', 'readwrite');
  const cur = await tx.store.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch, id };
  await tx.store.put(next);
  await tx.done;
  return next;
}

export async function deletePhotos(ids: string[]): Promise<void> {
  const d = await db();
  const tx = d.transaction(['photos', 'blobs', 'sigs'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('sigs').delete(id);
    tx.objectStore('photos').delete(id);
    tx.objectStore('blobs').delete(`${id}:full`);
    tx.objectStore('blobs').delete(`${id}:thumb`);
  }
  await tx.done;
}

export async function getBlob(id: string, kind: BlobKind): Promise<Blob | undefined> {
  const v = await (await db()).get('blobs', `${id}:${kind}`);
  if (v === undefined) return undefined;
  return v instanceof Blob ? v : new Blob([v], { type: 'image/jpeg' });
}

export async function getSettings(): Promise<Settings> {
  const v = (await (await db()).get('meta', 'settings')) as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...v };
}

export async function saveSettings(s: Settings): Promise<void> {
  await (await db()).put('meta', s, 'settings');
}

export async function clearEverything(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['photos', 'blobs', 'meta', 'sigs'], 'readwrite');
  await Promise.all([tx.objectStore('photos').clear(), tx.objectStore('blobs').clear(), tx.objectStore('meta').clear(), tx.objectStore('sigs').clear(), tx.done]);
}

export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getAllSigs(): Promise<Map<string, Sig>> {
  const d = await db();
  const tx = d.transaction('sigs');
  const out = new Map<string, Sig>();
  let cur = await tx.store.openCursor();
  while (cur) { out.set(cur.key, cur.value); cur = await cur.continue(); }
  return out;
}

export async function putSig(id: string, sig: Sig): Promise<void> {
  await (await db()).put('sigs', sig, id);
}
