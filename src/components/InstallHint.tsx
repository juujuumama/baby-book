import { isIOS, isStandalone } from '../lib/storage';

/** iOS deletes website data it thinks is unused. Home Screen apps are exempt. */
export function InstallHint({ compact }: { compact?: boolean }) {
  if (isStandalone()) return null;
  if (!isIOS()) {
    return compact ? null : <p class="muted small">Tip: install this as an app from your browser's menu so it opens like an app and keeps its storage.</p>;
  }
  return (
    <div class="install-hint">
      <strong>Add Baby Book to your Home Screen first.</strong>
      <p>Safari can clear photos saved by websites that aren't on the Home Screen. Tap <span class="kbd">Share</span>, then <span class="kbd">Add to Home Screen</span>, and open Baby Book from there.</p>
    </div>
  );
}
