import { useCallback, useEffect, useRef, useState } from 'react';
import { isLocalProvider, type ProviderConfig } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { hasAppChrome } from '../chrome.js';
import { CloudIcon, ComputerIcon } from '../icons.js';
import { ModelsView } from './ModelsView.js';
import { ModelServerView } from './ModelServerView.js';
import { FirstLocalModel } from '../components/engine/FirstLocalModel.js';

/**
 * The page's sections in reading order, as the side menu lists them. Each
 * target carries `data-models-section` with its id; the local ones below the
 * heading only exist on the full local page, not the first-model screen.
 */
export const MODELS_SECTIONS = [
  { id: 'cloud', label: 'Cloud providers', Icon: CloudIcon },
  { id: 'local', label: 'Local model server', Icon: ComputerIcon },
  { id: 'model-server', label: 'Model server', parent: 'local' },
  { id: 'agent-server', label: 'Agent server', parent: 'local' },
  { id: 'library', label: 'Models', parent: 'local' },
  { id: 'connections', label: 'Connected servers', parent: 'local' },
] as const;
export type ModelsSectionId = (typeof MODELS_SECTIONS)[number]['id'];

/** The section at the top of `scroller`, or the last one once it is scrolled to the end. */
export function activeModelsSection(scroller: HTMLElement): ModelsSectionId {
  const targets = [...scroller.querySelectorAll<HTMLElement>('[data-models-section]')];
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return (targets.at(-1)?.dataset.modelsSection ?? 'cloud') as ModelsSectionId;
  const top = scroller.getBoundingClientRect().top + 24;
  let cur = 'cloud';
  for (const t of targets) if (t.getBoundingClientRect().top <= top) cur = t.dataset.modelsSection!;
  return cur as ModelsSectionId;
}

/**
 * Cloud and local models on one scrolling page, Cloud first, with a side menu
 * that jumps to either and to the local page's own sections. Moving between
 * the `modelserver` and `models` destinations scrolls that section into view.
 * The local section holds the first-local-model guided screen when this
 * machine has no model yet, so the cloud list stays visible.
 */
export function ModelsWorkspace() {
  const view = useStore((s) => s.view);
  const firstRun = useFirstLocalModel();
  const showAll = useCallback(() => firstRun.set(false), [firstRun.set]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ModelsSectionId>('cloud');
  // The spy would light each section passed on the way down, so it waits
  // until the jump's scrolling has been still for a moment.
  const jumping = useRef(false);
  const settle = useRef(0);
  const settleAfter = (ms: number) => {
    clearTimeout(settle.current);
    settle.current = window.setTimeout(() => { jumping.current = false; }, ms);
  };
  const goTo = useCallback((to: ModelsSectionId) => {
    // A local section that is not on screen (the agent server before it
    // answers, a model's own page) lands on Local's heading instead.
    const find = (id: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-models-section="${id}"]`);
    const id = find(to) ? to : 'local';
    const target = find(id);
    if (!target) return;
    setActive(id);
    jumping.current = true;
    settleAfter(300);
    target.scrollIntoView?.({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }, []);
  // Section spy: it measures the page, so at most once a frame, not per scroll event.
  const spyFrame = useRef(0);
  const onScroll = () => {
    if (jumping.current) settleAfter(120);
    if (spyFrame.current) return;
    spyFrame.current = requestAnimationFrame(() => {
      spyFrame.current = 0;
      if (scrollRef.current && !jumping.current) setActive(activeModelsSection(scrollRef.current));
    });
  };
  // Arriving opens at the top; a later move between the two destinations
  // (the command palette, a voice command) scrolls to its section. Comparing
  // views, not counting runs: StrictMode runs this effect twice on arrival.
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current !== view) goTo(view === 'modelserver' ? 'local' : 'cloud');
    shown.current = view;
  }, [view, goTo]);
  const fullLocal = firstRun.value === false;
  return <div className="settings-panel">
    <aside className="settings-rail">
      {!hasAppChrome && <h1 className="view-title">Models</h1>}
      <nav aria-label="Models sections" className="settings-nav">
        {MODELS_SECTIONS.filter((s) => !('parent' in s) || fullLocal).map((s) => (
          <button
            key={s.id}
            type="button"
            className={'parent' in s ? 'settings-nav-item models-nav-sub' : 'settings-nav-item'}
            aria-current={active === s.id ? 'true' : undefined}
            onClick={() => goTo(s.id)}
          >
            {'Icon' in s && <s.Icon className="h-4 w-4 shrink-0" />}{s.label}
          </button>
        ))}
      </nav>
    </aside>
    <div ref={scrollRef} className="models-workspace" onScroll={onScroll}>
      <section data-models-section="cloud" className="models-section models-section-cloud" aria-labelledby="models-cloud-title">
        <h2 id="models-cloud-title" className="models-section-heading"><CloudIcon className="h-6 w-6 shrink-0" /> Cloud providers</h2>
        <ModelsView />
      </section>
      <section data-models-section="local" className="models-section models-section-local" aria-labelledby="models-local-title">
        <h2 id="models-local-title" className="models-section-heading"><ComputerIcon className="h-6 w-6 shrink-0" /> Local model server</h2>
        {firstRun.value === null ? null : firstRun.value ? <FirstLocalModel onShowAll={showAll} /> : <>
          <ModelServerView embedded />
          <div data-models-section="connections" className="models-local-connections">
            <h3 className="models-section-title">Connected servers</h3>
            <ModelsView localOnly />
          </div>
        </>}
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
