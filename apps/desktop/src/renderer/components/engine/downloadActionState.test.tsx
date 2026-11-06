import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadJob } from '@nekko-agent/shared';
import { createDownloadActions, matchesDownload, type DownloadTarget } from './downloadActionState.js';
import { DownloadProgress } from './DownloadProgress.js';
import { groupDownloads } from './downloadGroups.js';

const target: DownloadTarget = { model: 'org/repo', quant: 'Q4' };
const job = (extra: Partial<DownloadJob> = {}): DownloadJob => ({ id: 'model:org/repo:Q4', kind: 'model', label: 'Q4', target: 'org/repo', state: 'queued', startedAt: Date.now() + 1, receivedBytes: 0, ...extra });
const ok = { ok: true, message: 'Queued' };

describe('shared download action state', () => {
  it('locks synchronously, across two callers, before any response or event', async () => {
    const a = createDownloadActions();
    let resolve!: (r: typeof ok) => void;
    const request = vi.fn(() => new Promise<typeof ok>(r => { resolve = r; }));
    const first = a.run(target, request);
    expect(a.status(target).active).toBe(true);
    expect(await a.run(target, request)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    resolve(ok); await first;
    expect(a.status(target).active).toBe(true);
    a.update([]); // A poll before the first job is not completion.
    expect(a.status(target).active).toBe(true);
  });
  it.each(['queued', 'downloading', 'verifying'] as const)('adopts an existing %s job on mount', state => {
    const a = createDownloadActions(); a.update([job({ state })]);
    expect(a.status(target).active).toBe(true);
    expect(a.status(target).group?.state).toBe(state);
  });
  it.each(['done', 'failed', 'cancelled'] as const)('unlocks on %s and permits retry', async state => {
    const a = createDownloadActions(); await a.run(target, async () => ok);
    a.update([job({ state })]);
    expect(a.status(target).active).toBe(false);
    expect(await a.run(target, async () => ok)).toEqual(ok);
  });
  it('keeps the request locked if a terminal event beats the response', async () => {
    const a = createDownloadActions(); let resolve!: (r: typeof ok) => void;
    const first = a.run(target, () => new Promise(r => { resolve = r; }));
    a.update([job({ state: 'done' })]);
    expect(a.status(target).active).toBe(true);
    resolve(ok); await first;
    expect(a.status(target).active).toBe(false);
  });
  it('does not unlock a new request from historical completed jobs', async () => {
    const a = createDownloadActions(); a.update([job({ state: 'done', startedAt: 1 })]);
    await a.run(target, async () => ok);
    expect(a.status(target).active).toBe(true);
  });
  it('unlocks rejected requests and exceptions', async () => {
    const a = createDownloadActions();
    expect(await a.run(target, async () => { throw Error('offline'); })).toEqual({ ok: false, message: 'offline' });
    expect(a.status(target).active).toBe(false);
    await a.run(target, async () => ({ ok: false, message: 'denied' }));
    expect(a.status(target).active).toBe(false);
  });
  it('matches groups exactly and aggregates helpers/shards without locking other builds', () => {
    const a = createDownloadActions();
    const main = job({ receivedBytes: 20, totalBytes: 100, state: 'downloading' });
    const helper = job({ id: 'helper', group: main.id, receivedBytes: 22, totalBytes: 100, state: 'downloading' });
    a.update([main, helper, job({ id: 'model:org/repo:Q8', receivedBytes: 1000 })]);
    expect(a.status(target).group).toMatchObject({ receivedBytes: 42, totalBytes: 200 });
    expect(matchesDownload({ model: 'org/repo2', quant: 'Q4' }, main)).toBe(false);
    expect(matchesDownload(target, job({ id: 'model:org/repo:Q4-other' }))).toBe(false);
  });
  it('matches decision-model acquisitions by exact precision group', () => {
    const a = createDownloadActions();
    a.update([job({ id: 'decision:laya:weights:file.onnx', group: 'decision:laya:fp16' })]);
    expect(a.status({ group: 'decision:laya:fp16' }).active).toBe(true);
    expect(a.status({ group: 'decision:laya:fp32' }).active).toBe(false);
  });
  it.each(['llama', 'diffusion', 'mlx'] as const)('locks only the matching %s runtime, across all builds', runtime => {
    const a = createDownloadActions();
    a.update([job({ id: `engine:${runtime}:build`, kind: 'engine', target: 'build' })]);
    expect(a.status({ runtime }).active).toBe(true);
    expect(a.status(target).active).toBe(false);
    expect(a.status({ runtime: runtime === 'mlx' ? 'llama' : 'mlx' }).active).toBe(false);
  });
});

describe('inline progress', () => {
  it('is indeterminate immediately and when any file size is unknown', () => {
    expect(renderToStaticMarkup(<DownloadProgress />)).not.toContain('value=');
    const group = groupDownloads([job({ state: 'downloading' })])[0];
    expect(renderToStaticMarkup(<DownloadProgress group={group} />)).not.toContain('aria-valuenow');
  });
  it('shows live percent, clamped to the progress range', () => {
    const group = groupDownloads([job({ receivedBytes: 42, totalBytes: 100, state: 'downloading' })])[0];
    expect(renderToStaticMarkup(<DownloadProgress group={group} />)).toContain('aria-valuenow="42"');
    expect(renderToStaticMarkup(<DownloadProgress group={{ ...group, receivedBytes: 999 }} />)).toContain('aria-valuenow="100"');
  });
  it('says verifying until installation completes', () => {
    const group = groupDownloads([job({ state: 'verifying' })])[0];
    expect(renderToStaticMarkup(<DownloadProgress group={group} />)).toContain('Verifying…');
  });
});
