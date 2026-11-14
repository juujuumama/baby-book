import { useEffect, useMemo, useState } from 'preact/hooks';
import { ImportSheet } from './components/ImportButton';
import { NeedsDate } from './components/NeedsDate';
import { Onboarding } from './components/Onboarding';
import { SettingsView } from './components/Settings';
import { SortPrints } from './components/SortPrints';
import { Timeline } from './components/Timeline';
import { loadAll, useStore } from './store';

type Tab = 'timeline' | 'sort' | 'undated' | 'settings';
const TABS: Tab[] = ['timeline', 'sort', 'undated', 'settings'];

function tabFromHash(): Tab {
  const h = location.hash.replace('#/', '') as Tab;
  return TABS.includes(h) ? h : 'timeline';
}

export function App() {
  const { ready, settings, photos } = useStore();
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const undatedCount = useMemo(() => photos.filter((p) => !p.taken).length, [photos]);

  useEffect(() => {
    loadAll();
    const h = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const setTab = (t: Tab) => {
    history.replaceState(null, '', `#/${t}`);
    setTabState(t);
    window.scrollTo({ top: 0 });
  };

  if (!ready) return <div class="loading">Opening the book…</div>;
  if (!settings.birthDate) return <Onboarding />;

  const title = settings.babyName ? `${settings.babyName}'s Baby Book` : 'Baby Book';

  return (
    <div class="app">
      <header class="topbar">
        <h1>{title}</h1>
      </header>
      <main>
        {tab === 'timeline' && <Timeline onGoUndated={() => setTab('undated')} />}
        {tab === 'sort' && <SortPrints />}
        {tab === 'undated' && <NeedsDate />}
        {tab === 'settings' && <SettingsView />}
      </main>
      <nav class="tabbar" aria-label="Sections">
        <button class={tab === 'timeline' ? 'on' : ''} aria-current={tab === 'timeline'} onClick={() => setTab('timeline')}>
          <span class="tab-icon" aria-hidden="true">📖</span>Months
        </button>
        <button class={tab === 'sort' ? 'on' : ''} aria-current={tab === 'sort'} onClick={() => setTab('sort')}>
          <span class="tab-icon" aria-hidden="true">🗂️</span>Sort prints
        </button>
        <button class={tab === 'undated' ? 'on' : ''} aria-current={tab === 'undated'} onClick={() => setTab('undated')}>
          <span class="tab-icon" aria-hidden="true">📮</span>Needs a date{undatedCount > 0 && <span class="count">{undatedCount}</span>}
        </button>
        <button class={tab === 'settings' ? 'on' : ''} aria-current={tab === 'settings'} onClick={() => setTab('settings')}>
          <span class="tab-icon" aria-hidden="true">🧺</span>Settings
        </button>
      </nav>
      <ImportSheet />
    </div>
  );
}
