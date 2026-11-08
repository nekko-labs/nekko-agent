import { useCallback, useEffect, useRef, useState } from 'react';
import { isLocalProvider, type ProviderConfig } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { hasAppChrome } from '../chrome.js';
import { CloudIcon, ComputerIcon } from '../icons.js';
import { ModelsView } from './ModelsView.js';
import { ModelServerView } from './ModelServerView.js';
import { FirstLocalModel } from '../components/engine/FirstLocalModel.js';

/**
 * Cloud and local models on one page, side by side: Cloud on the left, Local
 * on the right (stacked, Cloud first, below the laptop breakpoint). Moving
 * between the `modelserver` and `models` destinations scrolls that column
 * into view. The local column holds the first-local-model guided screen
 * when this machine has no model yet, so the cloud list stays visible.
 */
export function ModelsWorkspace() {
  const view = useStore((s) => s.view);
  const firstRun = useFirstLocalModel();
  const showAll = useCallback(() => firstRun.set(false), [firstRun.set]);
  const localRef = useRef<HTMLElement>(null);
  const cloudRef = useRef<HTMLElement>(null);
  // Arriving opens at the top; a later move between the two destinations
  // (the command palette, a voice command) scrolls to its column. Comparing
  // views, not counting runs: StrictMode runs this effect twice on arrival.
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current !== view) (view === 'modelserver' ? localRef : cloudRef).current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    shown.current = view;
  }, [view]);
  return <div className="models-workspace models-workspace-split">
    <section ref={cloudRef} className="models-section models-section-cloud" aria-labelledby="models-cloud-title">
      {!hasAppChrome && <h1 className="view-title">Models</h1>}
      <h2 id="models-cloud-title" className="models-section-heading"><CloudIcon className="h-6 w-6 shrink-0" /> Cloud providers</h2>
      <ModelsView />
    </section>
    <section ref={localRef} className="models-section" aria-labelledby="models-local-title">
      <h2 id="models-local-title" className="models-section-heading"><ComputerIcon className="h-6 w-6 shrink-0" /> Local model server</h2>
      {firstRun.value === null ? null : firstRun.value ? <FirstLocalModel onShowAll={showAll} /> : <>
        <ModelServerView embedded />
        <div className="models-local-connections">
          <h3 className="models-section-title">Connected servers</h3>
          <ModelsView localOnly />
        </div>
      </>}
    </section>
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
