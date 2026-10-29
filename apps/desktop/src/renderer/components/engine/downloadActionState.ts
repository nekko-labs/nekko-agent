import { createStore } from 'zustand/vanilla';
import type { DownloadJob } from '@nekko-agent/shared';
import { groupDownloads, isActive } from './downloadGroups.js';

export type DownloadTarget = { model: string; quant: string } | { group: string } | { runtime: 'llama' | 'diffusion' | 'mlx' };
export const downloadKey = (target: DownloadTarget) => 'runtime' in target ? `engine:${target.runtime}` : 'group' in target ? target.group : `model:${target.model}:${target.quant}`;

export function matchesDownload(target: DownloadTarget, job: DownloadJob): boolean {
  if ('runtime' in target) return job.kind === 'engine' && job.id.startsWith(`engine:${target.runtime}:`);
  if ('group' in target) return job.kind === 'model' && job.group === target.group;
  const id = downloadKey(target);
  return job.kind === 'model' && (job.id === id || job.group === id);
}

type EngineActionResult = { ok: boolean; message: string };

type Pending = { target: DownloadTarget; since: number; requesting: boolean };
type State = { jobs: DownloadJob[]; pending: Record<string, Pending> };

/** One synchronous lock per acquisition, shared by every visible download button. */
export function createDownloadActions() {
  const store = createStore<State>(() => ({ jobs: [], pending: {} }));
  const prune = (pending: State['pending'], jobs: DownloadJob[]) => Object.fromEntries(Object.entries(pending).filter(([, p]) => {
    const current = jobs.filter(j => matchesDownload(p.target, j) && j.startedAt >= p.since);
    return p.requesting || !current.length || current.some(j => isActive(j.state));
  }));
  const update = (jobs: DownloadJob[]) => store.setState(s => ({ jobs, pending: prune(s.pending, jobs) }));
  const status = (target: DownloadTarget) => {
    const { jobs, pending } = store.getState();
    const related = jobs.filter(j => matchesDownload(target, j));
    const group = groupDownloads(related).find(g => g.jobs.some(j => isActive(j.state)));
    return { active: !!pending[downloadKey(target)] || !!group, group };
  };
  const run = async (target: DownloadTarget, request: () => Promise<EngineActionResult>): Promise<EngineActionResult | null> => {
    if (status(target).active) return null;
    const key = downloadKey(target);
    store.setState(s => ({ pending: { ...s.pending, [key]: { target, since: Date.now(), requesting: true } } }));
    let result: EngineActionResult;
    try { result = await request(); }
    catch (e) { result = { ok: false, message: e instanceof Error ? e.message : 'Could not start the download.' }; }
    store.setState(s => {
      const pending = { ...s.pending };
      if (!result.ok) delete pending[key];
      else pending[key] = { ...pending[key], requesting: false };
      return { pending: prune(pending, s.jobs) };
    });
    return result;
  };
  return { store, update, status, run };
}
