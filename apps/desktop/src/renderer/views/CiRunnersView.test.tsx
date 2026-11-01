import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The real Modal portals into document.body, which server rendering has none of.
vi.mock('../components/primitives/index.js', async (original) => ({
  ...await original<typeof import('../components/primitives/index.js')>(),
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

import { CiRunnersFirstVisit, afterList, afterReply, retryDelay, runnersBody } from './CiRunnersView.js';
import { DEFAULT_RUNNER_SETTINGS, type ImageView, type RunnerView } from '@nekko-agent/shared';
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
    for (const s of ['Use this Mac as a CI runner', 'Your own work comes first.', 'STEP 1', 'Connect GitHub', 'Two clicks on GitHub. Nothing to copy.', 'STEP 2', 'Set up this Mac', 'One click, then it builds your job VM by itself.', 'A repository plugged into a laptop', 'macOS downloading into a protected VM on a laptop']) {
      expect(html).toContain(s);
    }
    expect(html).not.toContain('Buildkite');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>After step 1</);
  });

  it('step_2_lights_up_once_a_runner_exists', () => {
    const html = renderToStaticMarkup(<CiRunnersFirstVisit connected onConnect={() => {}} onSetup={() => {}} />);
    expect(html).toContain('Connected');
    expect(html).not.toContain('After step 1');
    expect(html).toMatch(/<button[^>]*btn-primary[^>]*>Set up this Mac</);
    expect(renderToStaticMarkup(<CiRunnersFirstVisit connected canResume onConnect={() => {}} />)).toMatch(/<button[^>]*>Resume setup</);
  });

  it('the_two_steps_stay_above_the_card_until_there_is_an_image', () => {
    const view = { config: { id: 'r1', scope: { kind: 'repo', owner: 'o', repo: 'r' }, label: 'l', settings: DEFAULT_RUNNER_SETTINGS }, state: 'off', slots: [], reasons: [], available: 0, limit: null, awake: false, error: null, today: { jobs: 0, seconds: 0 }, host: { ramMb: 0, onBattery: null, networkId: null }, repos: [], forkApprovalOpen: false, recent: [] } as unknown as RunnerView;
    const at = (state: ImageView['state']) => renderToStaticMarkup(<>{runnersBody({ kind: 'ready', views: [view] }, { now: 0, image: { state, stage: null, doneStages: [], detail: '', bytes: null, fraction: null, error: null, log: null, info: null, canResume: false }, onConnect() {}, onSettings() {}, beginReply: () => () => {} })}</>);
    expect(at('none')).toContain('STEP 2');
    expect(at('none')).toContain('data-runner-card="r1"');
    expect(at('ready')).not.toContain('STEP 2');
    expect(at('building')).not.toContain('STEP 2');
  });

  it('shows_a_sentence_when_runners_are_unavailable', () => {
    const html = renderToStaticMarkup(<>{runnersBody({ kind: 'unavailable', message: 'unknown channel runner:list' }, { now: 0, onConnect() {}, onSettings() {}, beginReply: () => () => {} })}</>);
    // The daemon's own words for a missing channel are not a sentence: say what it needs instead.
    expect(html).toContain('CI runners aren&#x27;t available here. They need a Mac with Apple silicon and an up-to-date Nekko service.');
    expect(html).not.toContain('unknown channel');
    expect(html).not.toContain('aria-busy="true"');
    const other = renderToStaticMarkup(<>{runnersBody({ kind: 'unavailable', message: 'The Nekko service is not running.' }, { now: 0, onConnect() {}, onSettings() {}, beginReply: () => () => {} })}</>);
    expect(other).toContain('CI runners aren&#x27;t available here: The Nekko service is not running.');
  });

  it('a late list never overwrites a push', () => {
    const pushed = { kind: 'ready' as const, views: [] };
    expect(afterList({ kind: 'loading' }, { kind: 'unavailable', message: 'x' })).toEqual({ kind: 'unavailable', message: 'x' });
    expect(afterList(pushed, { kind: 'unavailable', message: 'x' })).toBe(pushed);
    expect(afterList(pushed, { kind: 'ready', views: [] })).toBe(pushed);
    expect(afterList({ kind: 'unavailable', message: 'x' }, pushed)).toBe(pushed); // a retry recovers
  });

  it('segment_switches_sections', () => {
    // Plain toggle buttons: a tablist would promise arrow keys and a tabpanel.
    const html = renderToStaticMarkup(<SectionSegment value="ciRunners" onChange={() => {}} />);
    expect(html).toContain('role="group" aria-label="Section"');
    expect(html).not.toContain('role="tab');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-pressed="true"[^>]*>CI runners</);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-pressed="false"[^>]*>Workflows</);
  });

  it('a reply loses to a push that arrived after its request started', () => {
    const v = (id: string, label: string) => ({ config: { id, label } }) as unknown as RunnerView;
    const ready = { kind: 'ready' as const, views: [v('r1', 'pushed')] };
    expect(afterReply(ready, v('r1', 'reply'), 3, 4)).toBe(ready);
    expect(afterReply(ready, v('r1', 'reply'), 4, 4)).toEqual({ kind: 'ready', views: [v('r1', 'reply')] });
    expect(afterReply(ready, v('r2', 'new'), 4, 4)).toEqual({ kind: 'ready', views: [v('r1', 'pushed'), v('r2', 'new')] });
    expect(afterReply({ kind: 'loading' }, v('r2', 'new'), 0, 0)).toEqual({ kind: 'ready', views: [v('r2', 'new')] });
  });

  it('retries an unavailable list with a bounded backoff', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(retryDelay)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
});
