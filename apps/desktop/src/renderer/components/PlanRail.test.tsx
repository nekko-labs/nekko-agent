import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
const store = vi.hoisted(() => ({ sessions: [] as unknown[] }));
vi.mock('../store.js', () => ({ useStore: Object.assign((selector: (state: unknown) => unknown) => selector({ sessions: store.sessions, openChatPane: () => {}, settings: {} }), { getState: () => ({ openChatPane: () => {} }) }) }));
import { PlanRail } from './PlanRail.js';
import { PlanSheet } from './PlanSheet.js';

const session = { agentPlan: [{ id: 'one', title: 'Inspect code', status: 'active' }] } as Session;
describe('minimize button', () => {
  it('sits at the far right of the header, only when minimizing is wired', () => {
    const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={null} onMinimize={() => {}} />);
    const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
    expect(header).toContain('aria-label="Minimize Agent Monitor"');
    expect(header.indexOf('data-plan-minimize')).toBeGreaterThan(header.indexOf('Agent Monitor</span>'));
    expect(renderToStaticMarkup(<PlanRail sessionId="s" session={null} />)).not.toContain('data-plan-minimize');
  });
});

it('keeps sub-agents in the Agent Monitor and leaves the plan to the composer sheet', () => {
  const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={session} />);
  expect(markup).toContain('>Sub-agents<');
  expect(markup).not.toContain('Inspect code');
});

describe('plan sheet, folded and open (#1317)', () => {
  const loop = { ...session, messages: [], agentPlan: [
    { id: 'a', createdAt: 1, updatedAt: 1, title: 'Find every inline check', status: 'done', kind: 'explore' },
    { id: 'b', createdAt: 1, updatedAt: 1, title: 'Move checks into one middleware', status: 'active', kind: 'build', pass: 2 },
    { id: 'c', createdAt: 1, updatedAt: 1, title: 'Auth tests pass', status: 'pending', kind: 'verify' },
    { id: 'd', createdAt: 1, updatedAt: 1, title: 'Open the PR', status: 'pending', kind: 'ship' },
  ] } as unknown as Session;
  it('folds by default to the step being worked: kind, title, pass and its place, with no Change plan', () => {
    const markup = renderToStaticMarkup(<PlanSheet sessionId="s" session={loop} streaming prs={[]} />);
    expect(markup).toContain('data-folded');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toMatch(/data-plan-kind="build" data-current="true">Build<\/span>/);
    expect(markup).toContain('Move checks into one middleware');
    expect(markup).toContain('Pass 2');
    expect(markup).toContain('2 of 4');
    expect(markup).not.toContain('Find every inline check');
    expect(markup).not.toContain('Change plan');
  });
  it('sums the sub-agents into one chip when folded, and puts each under its step when open', () => {
    store.sessions = [
      { id: 'k1', parentSessionId: 's', title: 'Map checks', createdAt: 0 },
      { id: 'k2', parentSessionId: 's', title: 'Update routes', createdAt: 0, activeRun: { startedAt: 1 } },
      { id: 'other', parentSessionId: 'x', title: 'Not mine', createdAt: 0 },
    ];
    try {
      const folded = renderToStaticMarkup(<PlanSheet sessionId="s" session={loop} streaming prs={[]} />);
      expect(folded).toMatch(/data-plan-chip="subagents" title="Sub-agents: 1 running, 1 done">Sub-agents<b>1<\/b>[^]*?aria-label="running"[^]*?<b>1<\/b>[^]*?aria-label="done"/);
      const open = renderToStaticMarkup(<PlanSheet sessionId="s" session={loop} streaming prs={[]} initiallyOpen />);
      expect(open).toContain('1 of 4 done');
      for (const kind of ['Explore', 'Build', 'Verify', 'Ship']) expect(open).toContain(`>${kind}</span>`);
      // No plan update in the transcript yet: sub-agents land on the first step.
      const first = open.slice(open.indexOf('data-plan-step-id="a"'), open.indexOf('data-plan-step-id="b"'));
      expect(first.match(/data-plan-chip="subagent"/g)).toHaveLength(2);
      expect(first).toContain('Update routes');
      expect(open).not.toContain('Not mine');
    } finally { store.sessions = []; }
  });
});

describe('per-step plan status icons', () => {
  const parallel = { ...session, messages: [], agentPlan: [
    { id: 'a', createdAt: 1, updatedAt: 1, title: 'Implement', status: 'active' },
    { id: 'b', createdAt: 1, updatedAt: 1, title: 'Test independently', status: 'active' },
    { id: 'c', createdAt: 1, updatedAt: 1, title: 'Inspect', status: 'done' },
    { id: 'd', createdAt: 1, updatedAt: 1, title: 'Publish', status: 'pending' },
    { id: 'e', createdAt: 1, updatedAt: 1, title: 'Animate', status: 'skipped' },
  ] } as Session;
  it.each([true, false])('shows every active step as Working, streaming=%s', (streaming) => {
    const markup = renderToStaticMarkup(<PlanSheet sessionId="s" session={parallel} streaming={streaming} prs={[]} initiallyOpen />);
    expect(markup.match(/aria-label="Working"/g)).toHaveLength(2);
    for (const status of ['Working', 'Done', 'Pending', 'Skipped']) expect(markup).toContain('title="' + status + '"');
    expect(markup).toContain('line-through');
    expect(markup).toContain('M6 18 18 6');
    const rows = markup.slice(markup.indexOf('<ol'), markup.indexOf('</ol>'));
    expect(rows).not.toContain('animate-');
    expect(rows).not.toContain('background:var(--accent)');
  });
  it('pauses all active entries only for an explicitly interrupted, non-running chat', () => {
    const interrupted = { ...parallel, messages: [{ role: 'assistant', content: 'Stopped', interrupted: true }] } as Session;
    const paused = renderToStaticMarkup(<PlanSheet sessionId="s" session={interrupted} streaming={false} prs={[]} initiallyOpen />);
    expect(paused.match(/aria-label="Paused"/g)).toHaveLength(2);
    expect(paused).not.toContain('aria-label="Working"');
    expect(paused).toContain('M8 5v14M16 5v14');
    for (const running of [interrupted, { ...interrupted, activeRun: { startedAt: 1 } }]) {
      const markup = renderToStaticMarkup(<PlanSheet sessionId="s" session={running} streaming={running === interrupted} prs={[]} initiallyOpen />);
      expect(markup.match(/aria-label="Working"/g)).toHaveLength(2);
    }
  });
});
