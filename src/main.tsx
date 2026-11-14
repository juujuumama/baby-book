import { render } from 'preact';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource-variable/nunito';
import './styles.css';
import { App } from './app';
import { registerSW } from 'virtual:pwa-register';

// Home Screen apps on iPhone can keep showing an old version. Check for a new
// one at launch, whenever the app comes back to the front, and hourly; when
// it's ready the page reloads itself (photos are in IndexedDB, so nothing is lost).
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 60 * 60 * 1000);
  },
});

render(<App />, document.getElementById('app')!);
