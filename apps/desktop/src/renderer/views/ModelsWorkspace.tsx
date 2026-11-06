import { useCallback, useEffect, useRef, useState } from 'react';
import { isLocalProvider, type ProviderConfig } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { hasAppChrome } from '../chrome.js';
import { CloudIcon, ComputerIcon } from '../icons.js';
import { ModelsView } from './ModelsView.js';
import { ModelServerView } from './ModelServerView.js';
import { FirstLocalModel } from '../components/engine/FirstLocalModel.js';

/**
 * Local and cloud models on one page, one section each. The page opens at
 * the top; moving between the `modelserver` and `models` destinations scrolls
 * to that section, so it mounts nothing and asks the engine for nothing new.
 */
export function ModelsWorkspace() {
  const view = useStore((s) => s.view);
  const firstRun = useFirstLocalModel();
  const showAll = useCallback(() => firstRun.set(false), [firstRun.set]);
  const localRef = useRef<HTMLElement>(null);
  const cloudRef = useRef<HTMLElement>(null);
  // Arriving opens at the top; a later move between the two destinations
  // (the command palette, a voice command) scrolls to its section.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) (view === 'modelserver' ? localRef : cloudRef).current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    arrived.current = true;
  }, [view]);
  return <div className="models-workspace">
    <section ref={localRef} className="models-section" aria-labelledby="models-local-title">
      {!hasAppChrome && <h1 className="view-title">Models</h1>}
      <h2 id="models-local-title" className="models-section-heading"><ComputerIcon className="h-6 w-6 shrink-0" /> Local model server</h2>
      {firstRun.value === null ? null : firstRun.value ? <FirstLocalModel onShowAll={showAll} /> : <>
        <ModelServerView embedded />
        <div className="models-local-connections">
          <h3 className="models-section-title">Connected servers</h3>
          <ModelsView localOnly />
        </div>
      </>}
    </section>
    <section ref={cloudRef} className="models-section models-section-cloud" aria-labelledby="models-cloud-title">
      <h2 id="models-cloud-title" className="models-section-heading"><CloudIcon className="h-6 w-6 shrink-0" /> Cloud providers</h2>
      <ModelsView />
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
