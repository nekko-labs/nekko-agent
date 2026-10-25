import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The real Modal portals into document.body, which server rendering has none of.
vi.mock('../components/primitives/index.js', async (original) => ({
  ...await original<typeof import('../components/primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { CiRunnersFirstVisit, afterList, runnersBody } from './CiRunnersView.js';
import { SectionSegment } from './WorkflowsView.js';

(globalThis as unknown as { window: unknown }).window = {
  nekko: {
    listRunners: () => Promise.reject(new Error('unknown channel runner:list')),
    onRunnersChanged: () => () => {},
    setRunnerEnabled: () => Promise.reject(new Error('unused')),
  },
};

describe('CI runners section', () => {
  it('first_visit_matches_mockup_1', () => {
    const html = renderToStaticMarkup(<CiRunnersFirstVisit onConnect={() => {}} />);
    for (const s of ['Use this Mac as a CI runner', 'Connect GitHub', 'VM per job', '1 macOS slot', 'Do not disturb: Only run when I&#x27;m idle', 'Only on power', 'Private repos unless you allow public']) {
      expect(html).toContain(s);
    }
    expect(html).not.toContain('Buildkite');
  });

  it('shows_a_sentence_when_runners_are_unavailable', () => {
    const html = renderToStaticMarkup(<>{runnersBody({ kind: 'unavailable', message: 'unknown channel runner:list' }, { now: 0, onConnect() {}, onSettings() {}, onChanged() {} })}</>);
    expect(html).toContain('CI runners aren&#x27;t available here: unknown channel runner:list');
    expect(html).not.toContain('aria-busy="true"');
  });

  it('a late list never overwrites a push', () => {
    const pushed = { kind: 'ready' as const, views: [] };
    expect(afterList({ kind: 'loading' }, { kind: 'unavailable', message: 'x' })).toEqual({ kind: 'unavailable', message: 'x' });
    expect(afterList(pushed, { kind: 'unavailable', message: 'x' })).toBe(pushed);
    expect(afterList(pushed, { kind: 'ready', views: [] })).toBe(pushed);
  });

  it('segment_switches_sections', () => {
    const html = renderToStaticMarkup(<SectionSegment value="ciRunners" onChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>CI runners</);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*>Workflows</);
  });
});
