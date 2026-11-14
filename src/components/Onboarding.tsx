import { useState } from 'preact/hooks';
import { saveSettings, useStore } from '../store';
import { InstallHint } from './InstallHint';

export function Onboarding() {
  const { settings } = useStore();
  const [name, setName] = useState(settings.babyName);
  const [birth, setBirth] = useState(settings.birthDate);
  return (
    <div class="onboarding">
      <div class="card welcome">
        <div class="welcome-art" aria-hidden="true">☁️ 🌙 ⭐</div>
        <h1>Welcome to your baby book</h1>
        <p>Sort your photos by month, pick favorites, and plan pages for the scrapbook. Everything stays on this device, private and offline.</p>
        <InstallHint compact />
        <label class="field">
          <span>Baby's first name or nickname (optional)</span>
          <input type="text" value={name} autocomplete="off" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Birth date</span>
          <input type="date" value={birth} onInput={(e) => setBirth((e.target as HTMLInputElement).value)} />
        </label>
        <button class="btn primary block" disabled={!birth} onClick={() => saveSettings({ ...settings, babyName: name.trim(), birthDate: birth })}>
          Let's begin
        </button>
        <p class="muted small center">Already have a backup? Restore it from Settings after you begin.</p>
      </div>
    </div>
  );
}
