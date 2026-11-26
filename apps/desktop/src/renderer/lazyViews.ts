import { lazy } from 'react';

/**
 * The views the command view does not need to paint, split out of the entry
 * chunk. Each one is fetched on idle after first paint (`prefetchViews`), so by
 * the time anyone switches tabs the module is already evaluated and React.lazy
 * resolves without suspending: the warm switch stays inside the speed contract.
 */
const loaders = {
  artifacts: () => import('./views/ArtifactsView.js').then((m) => ({ default: m.ArtifactsView })),
  skills: () => import('./views/SkillsView.js').then((m) => ({ default: m.SkillsView })),
  training: () => import('./views/TrainingView.js').then((m) => ({ default: m.TrainingView })),
  workflows: () => import('./views/WorkflowsView.js').then((m) => ({ default: m.WorkflowsView })),
  design: () => import('./views/DesignBoardView.js').then((m) => ({ default: m.DesignBoardView })),
  models: () => import('./views/ModelsWorkspace.js').then((m) => ({ default: m.ModelsWorkspace })),
  connectors: () => import('./views/ConnectorsView.js').then((m) => ({ default: m.ConnectorsView })),
  memory: () => import('./views/MemoryView.js').then((m) => ({ default: m.MemoryView })),
  settings: () => import('./views/SettingsView.js').then((m) => ({ default: m.SettingsView })),
  onboarding: () => import('./views/OnboardingView.js').then((m) => ({ default: m.OnboardingView })),
};

export const ArtifactsView = lazy(loaders.artifacts);
export const SkillsView = lazy(loaders.skills);
export const TrainingView = lazy(loaders.training);
export const WorkflowsView = lazy(loaders.workflows);
export const DesignBoardView = lazy(loaders.design);
export const ModelsWorkspace = lazy(loaders.models);
export const ConnectorsView = lazy(loaders.connectors);
export const MemoryView = lazy(loaders.memory);
export const SettingsView = lazy(loaders.settings);
export const OnboardingView = lazy(loaders.onboarding);

type Idle = (cb: () => void) => void;
const whenIdle: Idle = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(cb, { timeout: 4000 });
  else setTimeout(cb, 200);
};

let started = false;
const PREFETCH_DELAY_MS = 1500;

/**
 * Fetch every split view, one per idle slice so no single parse blocks input,
 * starting after first paint. Safe to call more than once; a failed load is left
 * for the lazy component to retry (and surface) when the view is opened.
 */
export function prefetchViews(): void {
  if (started) return;
  started = true;
  const queue = Object.values(loaders);
  const next = () => {
    const load = queue.shift();
    if (!load) return;
    load().catch(() => {}).finally(() => whenIdle(next));
  };
  // Past first paint and the first interactive frames (about 300 ms cold), so the fetches never
  // compete with them. Opening a tab inside this window waits on one local file read at most.
  const start = () => setTimeout(() => whenIdle(next), PREFETCH_DELAY_MS);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
