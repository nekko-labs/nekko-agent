import { useCallback, useEffect, useRef, useState } from 'react';
import { isLocalProvider, type ProviderConfig } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { hasAppChrome } from '../chrome.js';
import { ModelsView } from './ModelsView.js';
import { ModelServerView } from './ModelServerView.js';
import { FirstLocalModel } from '../components/engine/FirstLocalModel.js';

/**
 * Local and cloud models on one page, one section each. The page opens at
 * the top; the subnavigation scrolls to a section and marks the one in view,
 * so moving between them mounts nothing and asks the engine for nothing new.
 */
export function ModelsWorkspace() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const firstRun = useFirstLocalModel();
  const showAll = useCallback(() => firstRun.set(false), [firstRun.set]);
  const contentRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLElement>(null);
  const cloudRef = useRef<HTMLElement>(null);
  const [inView, setInView] = useState<'local' | 'cloud'>('local');
  // Arriving opens at the top; a later move between the two destinations
  // (the subnavigation, the command palette) scrolls to its section.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) (view === 'modelserver' ? localRef : cloudRef).current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    arrived.current = true;
  }, [view]);
  const onScroll = () => {
    const content = contentRef.current;
    const cloud = cloudRef.current;
    if (!content || !cloud) return;
    const bottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 2;
    const reached = cloud.getBoundingClientRect().top - content.getBoundingClientRect().top < content.clientHeight / 3;
    setInView(bottom || reached ? 'cloud' : 'local');
  };
  const go = (to: 'local' | 'cloud') => {
    setInView(to);
    (to === 'local' ? localRef : cloudRef).current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    setView(to === 'local' ? 'modelserver' : 'models');
  };
  return <div className="models-workspace">
    <nav className="models-subnav" aria-label="Models">
      {!hasAppChrome && <h1 className="view-title">Models</h1>}
      <button type="button" aria-current={inView === 'local' ? 'location' : undefined} onClick={() => go('local')}>
        <span aria-hidden="true">▣</span> Local model server
      </button>
      <button type="button" aria-current={inView === 'cloud' ? 'location' : undefined} onClick={() => go('cloud')}>
        <span aria-hidden="true">☁</span> Cloud providers
      </button>
    </nav>
    <div className="models-content" ref={contentRef} onScroll={onScroll}>
      <section ref={localRef} className="models-section" aria-labelledby="models-local-title">
        <h2 id="models-local-title" className="models-section-title">Local model server</h2>
        {firstRun.value === null ? null : firstRun.value ? <FirstLocalModel onShowAll={showAll} /> : <>
          <ModelServerView embedded />
          <div className="models-local-connections">
            <h3 className="models-section-title">Connected servers</h3>
            <ModelsView localOnly />
          </div>
        </>}
      </section>
      <section ref={cloudRef} className="models-section models-section-cloud" aria-labelledby="models-cloud-title">
        <h2 id="models-cloud-title" className="models-section-title">Cloud providers</h2>
        <ModelsView />
      </section>
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
