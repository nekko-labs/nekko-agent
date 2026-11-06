import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
vi.mock('./ChatArtifacts.js', () => ({ ChatArtifacts: () => <div>Artifact cards</div> }));
const discovery = vi.hoisted(() => ({ update: vi.fn(), dispose: vi.fn(), onOpen: null as null | (() => void) }));
vi.mock('./artifactDiscovery.js', () => ({
  createArtifactDiscovery: (open: () => void) => { discovery.onOpen = open; return { update: discovery.update, dispose: discovery.dispose }; },
}));
// Effects are collected while `effects` is set, so a test can run them (and
// their cleanups) the way a mount and unmount would; otherwise React's own.
const hooks = vi.hoisted(() => ({ effects: null as null | Array<() => void | (() => void)> }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const useEffect: typeof actual.useEffect = (fn, deps) => (hooks.effects ? void hooks.effects.push(fn) : actual.useEffect(fn, deps));
  return { ...actual, default: { ...actual, useEffect }, useEffect };
});
import { MonitorArtifacts } from './MonitorArtifacts.js';

function mountAndUnmount(element: React.ReactElement) {
  hooks.effects = [];
  try {
    const markup = renderToStaticMarkup(element);
    const cleanups = hooks.effects.map((fn) => fn());
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
    return markup;
  } finally { hooks.effects = null; }
}

describe('monitor artifacts section', () => {
  it('starts collapsed with a zero count and a persistent accessible status region', () => {
    const markup = renderToStaticMarkup(<MonitorArtifacts sessionId="s" artifacts={[]} hydrated />);
    expect(markup).not.toContain('open=""');
    expect(markup).toContain('>0</span>');
    expect(markup).toContain('No artifacts yet.');
    expect(markup).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(markup).not.toContain('New artifact');
  });

  it('renders hydrated history without announcing it', () => {
    const markup = renderToStaticMarkup(<MonitorArtifacts sessionId="s" artifacts={[{ path: '/history.md', filename: 'history.md', title: 'History' }]} hydrated />);
    expect(markup).toContain('>1</span>');
    expect(markup).toContain('Artifact cards');
    expect(markup).not.toContain('New artifact');
    expect(markup).not.toContain('open=""');
  });

  it('feeds discovery the artifact paths only once hydrated, and disposes it on unmount', () => {
    discovery.update.mockClear(); discovery.dispose.mockClear();
    const artifacts = [{ path: '/a.md', filename: 'a.md', title: 'A' }, { path: '/b.md', filename: 'b.md', title: 'B' }];
    mountAndUnmount(<MonitorArtifacts sessionId="s" artifacts={artifacts} hydrated={false} />);
    expect(discovery.update).toHaveBeenLastCalledWith('s', null);
    expect(discovery.dispose).toHaveBeenCalledOnce();
    mountAndUnmount(<MonitorArtifacts sessionId="s" artifacts={artifacts} hydrated />);
    expect(discovery.update).toHaveBeenLastCalledWith('s', ['/a.md', '/b.md']);
  });

  it('lets discovery open only the native disclosure, without a toggle handler or store', () => {
    const markup = renderToStaticMarkup(<MonitorArtifacts sessionId="s" artifacts={[]} hydrated />);
    // A plain <details>: nothing but discovery opens it, and no animate-* class re-runs on open.
    expect(markup).toMatch(/^<details class="[^"]*"/);
    expect(markup).not.toContain('animate-');
    expect(discovery.onOpen).toBeTypeOf('function');
  });
});

describe('plan rail artifacts', () => {
  it('keys the section by chat and treats it as hydrated only once the open chat\'s messages are loaded', async () => {
    vi.resetModules();
    const seen: Array<{ sessionId: string; hydrated: boolean }> = [];
    vi.doMock('./MonitorArtifacts.js', () => ({ MonitorArtifacts: (p: { sessionId: string; hydrated: boolean }) => { seen.push(p); return null; } }));
    vi.doMock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ sessions: [], openChatPane: () => {}, settings: {} }) }));
    const { PlanRail } = await import('./PlanRail.js');
    const chat = (id: string, messages?: unknown[]) => ({ id, messages, agentPlan: [] }) as unknown as Session;
    renderToStaticMarkup(<PlanRail sessionId="s" session={chat('s', [])} />);
    renderToStaticMarkup(<PlanRail sessionId="s" session={chat('other', [])} />);
    renderToStaticMarkup(<PlanRail sessionId="s" session={chat('s')} />);
    renderToStaticMarkup(<PlanRail sessionId="s" session={null} />);
    expect(seen.map((p) => p.hydrated)).toEqual([true, false, false, false]);
    expect(seen.every((p) => p.sessionId === 's')).toBe(true);
  });
});
