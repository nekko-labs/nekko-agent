import { useCallback, useEffect, useState } from 'react';
import { isLocalProvider, type ProviderConfig } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { hasAppChrome } from '../chrome.js';
import { ModelsView } from './ModelsView.js';
import { ModelServerView } from './ModelServerView.js';
import { FirstLocalModel } from '../components/engine/FirstLocalModel.js';

/** Keep existing destinations working, with one rail entry and shared subnavigation. */
export function ModelsWorkspace() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const local = view === 'modelserver';
  const firstRun = useFirstLocalModel();
  const showAll = useCallback(() => firstRun.set(false), [firstRun.set]);
  return <div className="models-workspace">
    <nav className="models-subnav" aria-label="Models">
      {!hasAppChrome && <h1 className="view-title">Models</h1>}
      <button type="button" aria-current={local ? 'page' : undefined} onClick={() => setView('modelserver')}>
        <span aria-hidden="true">▣</span> Local model server
      </button>
      <button type="button" aria-current={!local ? 'page' : undefined} onClick={() => setView('models')}>
        <span aria-hidden="true">☁</span> Cloud providers
      </button>
    </nav>
    <div className="models-content" key={local ? 'local' : 'cloud'}>
      {local && firstRun.value === null ? null : local && firstRun.value ? <FirstLocalModel onShowAll={showAll} /> : <>
        <h2 className="models-section-title">{local ? 'Local model server' : 'Cloud providers'}</h2>
        {local ? <>
          <ModelServerView embedded />
          <div className="models-local-connections">
            <h3 className="models-section-title">Connected servers</h3>
            <ModelsView localOnly />
          </div>
        </> : <ModelsView />}
      </>}
    </div>
  </div>;
}

export function guideFirstModel(providers: Pick<ProviderConfig, 'enabled' | 'kind'>[], models: unknown[]): boolean {
  return models.length === 0 && !providers.some((p) => p.enabled && p.kind !== 'llamacpp' && isLocalProvider(p.kind));
}

/**
 * Whether this person has never run a model here: no model on disk (borrowed
 * folders count) and no local server of their own connected. Decided once per
 * visit, so the guided screen does not vanish the moment its download lands.
 * `null` while the engine answers, so the full page never flashes first.
 */
function useFirstLocalModel() {
  const [value, set] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    window.nekko.engineModels()
      .then((models) => { if (live) set(guideFirstModel(useStore.getState().providers, models)); })
      .catch(() => { if (live) set(false); });
    return () => { live = false; };
  }, []);
  return { value, set };
}
