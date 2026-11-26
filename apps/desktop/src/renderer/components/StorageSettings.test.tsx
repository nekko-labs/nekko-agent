// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CloudStatus, IdlePreview, RunnerImage, StorageUsage } from '@nekko-agent/shared';
import { StorageSettings, formatBytes } from './StorageSettings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GB = 1e9;
const usage = (over: Partial<Record<string, number | null>> = {}): StorageUsage => ({
  measuredAt: Date.now() - 120_000,
  measuring: false,
  disk: { total: 2e12, free: 14 * GB },
  worktreeBytes: {},
  categories: [
    { id: 'worktrees', bytes: 'worktrees' in over ? over.worktrees! : 180 * GB, detail: { count: 158, buildOutputBytes: 135 * GB } },
    { id: 'runners', bytes: 'runners' in over ? over.runners! : 134 * GB },
    { id: 'models', bytes: 53 * GB, detail: { elsewhere: false } },
    { id: 'history', bytes: 'history' in over ? (over.history ?? null) : 1.2 * GB, detail: { picturesBytes: 113e6 } },
    { id: 'caches', bytes: 1.9 * GB },
    { id: 'other', bytes: 70e6 },
  ],
});

const images: RunnerImage[] = [
  { name: 'images/default', bytes: 55 * GB, modifiedAt: 0, inUse: true, kind: 'macos' },
  { name: 'old-image-tart-2026-10-29', bytes: 76 * GB, modifiedAt: Date.UTC(2026, 9, 29), inUse: false, kind: 'other' },
];

const preview: IdlePreview = {
  idle: [
    { root: '/r/.worktrees/compact-agents-panel', projectName: 'nekko-agent', branch: 'compact-agents-panel', head: 'aaaaaaa1', bytes: 2 * GB, reason: 'pushed' },
    { root: '/r/.worktrees/p4-fleet', projectName: 'nekko-agent', branch: 'feat/p4-fleet', head: 'bbbbbbb2', bytes: 1 * GB, reason: 'merged' },
    { root: '/r/.worktrees/merge-sweep', projectName: 'nekko-agent', branch: null, head: '8c1e0a2ff', bytes: null, reason: 'pushed' },
  ],
  kept: { recent: 2, dirty: 1 },
};

const GiB = 2 ** 30;
const cloud = (plan: string, bytes: number, parts = { chats: 1.6 * GiB, library: 0.9 * GiB, revisions: 0.3 * GiB, shares: 80 * 2 ** 20 }) => ({
  signedIn: true,
  account: { email: 'you@example.com', plan, canSync: plan !== 'free' },
  sync: { usage: plan === 'free' ? { bytes: 0, limit: 0 } : { bytes, limit: plan === 'team' ? 20 * 2 ** 30 : 5 * 2 ** 30, parts } },
}) as unknown as CloudStatus;

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); });

function api(over: Record<string, unknown> = {}) {
  const a = {
    getStorageUsage: vi.fn(async () => usage()),
    listRunnerImages: vi.fn(async () => images),
    previewIdleWorktrees: vi.fn(async () => preview),
    removeWorktrees: vi.fn(async (roots: string[]) => ({ removed: roots, freed: 3 * GB, failed: [] })),
    removeRunnerImage: vi.fn(async () => ({ freed: 76 * GB })),
    clearAppCaches: vi.fn(async () => {}),
    cloudStatus: vi.fn(async () => cloud('pro', 2.8 * GiB)),
    getHistoryUsage: vi.fn(async () => ({ bytes: 1.2 * GB, count: 212 })),
    clearHistory: vi.fn(async () => 0),
    ...over,
  };
  (window as unknown as { nekko: unknown }).nekko = a;
  return a;
}

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<StorageSettings goTo={() => {}} openView={() => {}} refreshSessions={async () => {}} />); });
  await act(async () => {});
}

const rowIds = () => [...host.querySelectorAll('[data-storage-row]')].map((r) => r.getAttribute('data-storage-row'));
const row = (id: string) => host.querySelector(`[data-storage-row="${id}"]`) as HTMLElement;
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => {}); };

describe('formatBytes', () => {
  it('uses decimal units, one decimal under 10', () => {
    expect([formatBytes(14 * GB), formatBytes(1.9 * GB), formatBytes(113e6), formatBytes(2e12), formatBytes(1.6e12), formatBytes(512)]).toEqual(['14 GB', '1.9 GB', '113 MB', '2 TB', '1.6 TB', '1 KB']);
  });
});

describe('Settings → Storage', () => {
  it('shows the disk and each category largest first, unmeasured last', async () => {
    api({ getStorageUsage: vi.fn(async () => usage({ history: null })) });
    await mount();
    expect(host.textContent).toContain('14 GB free of 2 TB');
    expect(rowIds()).toEqual(['worktrees', 'runners', 'models', 'caches', 'other', 'history']);
    expect(row('worktrees').textContent).toContain('180 GB');
    expect(row('worktrees').textContent).toContain('158 checkouts · 135 GB of it is build output');
    expect(row('history').textContent).toContain('Measuring…');
    expect(row('runners').textContent).toContain('1 unused old image runner · 76 GB');
  });

  it('hides runner images when there are none, and app caches outside the desktop app', async () => {
    api({ getStorageUsage: vi.fn(async () => usage({ runners: 0 })), listRunnerImages: vi.fn(async () => []), clearAppCaches: undefined });
    await mount();
    expect(rowIds()).not.toContain('runners');
    expect(rowIds()).not.toContain('caches');
  });

  it('previews idle worktrees with select all and deselect all, and removes only the ticked ones', async () => {
    const a = api();
    await mount();
    await click(button('Remove idle worktrees…'));
    expect(host.textContent).toContain('Remove 3 idle worktrees? Frees about 3 GB.');
    expect(host.textContent).toContain('3 of 3 selected · 3 GB');
    expect(host.textContent).toContain('feat/p4-fleet · PR merged');
    expect(host.textContent).toContain('detached at 8c1e0a2');
    expect(host.textContent).toContain('3 kept');
    expect(host.textContent).toContain('2 used in the last 3 days · 1 with uncommitted changes');
    await click(button('Deselect all'));
    expect(host.textContent).toContain('0 of 3 selected');
    expect(button('Remove 0 worktrees').disabled).toBe(true);
    await click(button('Select all'));
    await click(host.querySelector('input[data-worktree="/r/.worktrees/p4-fleet"]')!);
    expect(host.textContent).toContain('2 of 3 selected · 2 GB');
    await click(button('Remove 2 worktrees'));
    expect(a.removeWorktrees).toHaveBeenCalledWith(['/r/.worktrees/compact-agents-panel', '/r/.worktrees/merge-sweep']);
    expect(a.getStorageUsage).toHaveBeenLastCalledWith(true);
  });

  it('lists runner images and removes a leftover only after its own confirmation', async () => {
    const a = api();
    await mount();
    await click(button('Review images…'));
    const inUse = host.querySelector('[data-runner-image="images/default"]')!;
    expect(inUse.textContent).toContain('In use');
    expect(inUse.querySelector('button')).toBeNull();
    await click(host.querySelector('[data-runner-image="old-image-tart-2026-10-29"] button')!);
    expect(host.textContent).toContain('Remove old-image-tart-2026-10-29? Frees 76 GB.');
    expect(a.removeRunnerImage).not.toHaveBeenCalled();
    await click(button('Remove permanently'));
    expect(a.removeRunnerImage).toHaveBeenCalledWith('old-image-tart-2026-10-29');
  });

  it('confirms before clearing caches', async () => {
    const a = api();
    await mount();
    await click(button('Clear caches…'));
    expect(host.textContent).toContain('Clear 1.9 GB of caches?');
    expect(a.clearAppCaches).not.toHaveBeenCalled();
    await click(button('Clear caches'));
    expect(a.clearAppCaches).toHaveBeenCalled();
  });

  it('splits Nekko Cloud storage by kind and never offers it as freeing local space', async () => {
    api();
    await mount();
    const c = host.querySelector('[data-storage-cloud]')!;
    expect(c.textContent).toContain('of 5 GB · Pro');
    expect(c.textContent).toContain('Synced chats 1.6 GB');
    expect(c.textContent).toContain('Library files 922 MB');
    expect(c.textContent).toContain('Kept revisions 307 MB');
    expect(c.textContent).toContain('Shares 80 MB');
    expect(c.textContent).toContain('your files stay on');
  });

  it('warns when Nekko Cloud is almost full', async () => {
    api({ cloudStatus: vi.fn(async () => cloud('pro', 4.9 * 2 ** 30, { chats: 4.9 * 2 ** 30, library: 0, revisions: 0, shares: 0 })) });
    await mount();
    expect(host.querySelector('[data-storage-cloud]')!.textContent).toContain('Almost full. New and changed files stop syncing at 5 GB.');
  });

  it('shows one line and no bar without a plan that syncs', async () => {
    api({ cloudStatus: vi.fn(async () => cloud('free', 0)) });
    await mount();
    const c = host.querySelector('[data-storage-cloud]')!;
    expect(c.textContent).toContain('Nekko Cloud keeps a synced, encrypted copy of your chats and Library on Pro and Enterprise.');
    expect(c.querySelector('[data-storage-bar]')).toBeNull();
  });
});
