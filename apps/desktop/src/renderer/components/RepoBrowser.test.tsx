import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
vi.mock('../store.js', async (original) => {
  const actual = await original<typeof import('../store.js')>();
  return { ...actual, useStore: Object.assign((selector: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()), actual.useStore) };
});
import type { RemoteRepo } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { RepoBrowser, filterRepos, savedClone } from './RepoBrowser.js';

const repo = (fullName: string, description = '', provider: RemoteRepo['provider'] = 'github'): RemoteRepo => ({
  provider, id: fullName, fullName, cloneUrl: `https://github.com/${fullName}.git`, webUrl: '', defaultBranch: 'main', private: false, description, updatedAt: '',
});

describe('repository browser (#2404)', () => {
  it('filters by name or description, case-insensitively', () => {
    const list = [repo('me/app', 'The desktop app'), repo('me/site', 'Marketing'), repo('org/tools', 'Build APP helpers')];
    expect(filterRepos(list, '').length).toBe(3);
    expect(filterRepos(list, ' app ').map((r) => r.fullName)).toEqual(['me/app', 'org/tools']);
    expect(filterRepos(list, 'nothing')).toEqual([]);
  });

  it('finds the saved folder already holding a clone, per provider', () => {
    const saved = [
      { id: 'a', name: 'app', path: '/c/app', addedAt: 0, repo: { provider: 'github' as const, fullName: 'Me/App' } },
      { id: 'b', name: 'plain', path: '/c/plain', addedAt: 0 },
    ];
    expect(savedClone(saved, { provider: 'github', fullName: 'me/app' })?.id).toBe('a');
    expect(savedClone(saved, { provider: 'gitlab', fullName: 'me/app' })).toBeUndefined();
  });

  it('asks to connect a git provider when none is connected', () => {
    const prev = useStore.getState();
    useStore.setState({ settings: { ...prev.settings, connectors: [{ kind: 'slack', connected: true }] } as any });
    try {
      const out = renderToStaticMarkup(<RepoBrowser onPick={async () => {}} onConnect={() => {}} />);
      expect(out).toContain('Connect repositories');
      expect(out).not.toContain('Search repositories');
    } finally { useStore.setState({ settings: prev.settings }); }
  });

  it('shows the search once GitHub or GitLab is connected', () => {
    const prev = useStore.getState();
    useStore.setState({ settings: { ...prev.settings, connectors: [{ kind: 'gitlab', connected: true, token: 't' }] } as any });
    try {
      const out = renderToStaticMarkup(<RepoBrowser onPick={async () => {}} onConnect={() => {}} />);
      expect(out).toContain('aria-label="Search repositories"');
      expect(out).toContain('Loading repositories…');
    } finally { useStore.setState({ settings: prev.settings }); }
  });
});
