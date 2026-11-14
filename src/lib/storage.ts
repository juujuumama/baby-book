export interface StorageStatus {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  standalone: boolean;
  ios: boolean;
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function storageStatus(): Promise<StorageStatus> {
  const s = navigator.storage;
  const [persisted, est] = await Promise.all([
    s?.persisted?.().catch(() => null) ?? null,
    s?.estimate?.().catch(() => null) ?? null,
  ]);
  return {
    persisted,
    usage: est?.usage ?? null,
    quota: est?.quota ?? null,
    standalone: isStandalone(),
    ios: isIOS(),
  };
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
