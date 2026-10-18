import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector({ sessions: [], openChatPane: () => {}, settings: {} }) }));
import { PlanRail, PLAN_CHANGE_REQUEST } from './PlanRail.js';
import { PlanChangePrompt, planChangeMessage } from './PlanChangePrompt.js';

const session = { agentPlan: [{ id: 'one', title: 'Inspect code', status: 'active' }] } as Session;
describe('change plan action', () => {
  it('offers the action while a plan is shown', () => {
    const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={session} streaming onChangePlan={() => {}} />);
    expect(markup).toContain('Change plan</button>');
    expect(markup).not.toContain('Want to change the approach?');
  });
  it('disables the action when editing is unavailable and hides it without a plan', () => {
    expect(renderToStaticMarkup(<PlanRail sessionId="s" session={session} streaming={false} />)).toContain('disabled=""');
    expect(renderToStaticMarkup(<PlanRail sessionId="s" session={null} streaming={false} />)).not.toContain('Change plan');
  });
});

describe('minimize button', () => {
  it('sits at the far right of the header, only when minimizing is wired', () => {
    const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={null} streaming={false} onMinimize={() => {}} />);
    const header = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
    expect(header).toContain('aria-label="Minimize Agent Monitor"');
    expect(header.indexOf('data-plan-minimize')).toBeGreaterThan(header.indexOf('Agent Monitor</span>'));
    expect(renderToStaticMarkup(<PlanRail sessionId="s" session={null} streaming={false} />)).not.toContain('data-plan-minimize');
  });
});

describe('plan change prompt', () => {
  it('asks what to change, with a text box, Send change and Cancel', () => {
    const markup = renderToStaticMarkup(<PlanChangePrompt running onSend={() => {}} onCancel={() => {}} />);
    expect(markup).toContain('What should the agent do differently?');
    expect(markup).toContain('<textarea');
    expect(markup).toContain('Send change</button>');
    expect(markup).toContain('Cancel</button>');
    expect(markup).toContain('applies at its next step');
    // Nothing to send until something is typed.
    expect(markup).toMatch(/disabled=""[^>]*>Send change/);
  });
  it('says an idle agent gets the change as a new turn', () => {
    expect(renderToStaticMarkup(<PlanChangePrompt running={false} onSend={() => {}} onCancel={() => {}} />)).toContain('starts a new turn');
  });
  it('sends the standing request followed by what was typed', () => {
    expect(planChangeMessage('  skip the migration  ')).toBe(`${PLAN_CHANGE_REQUEST}skip the migration`);
  });
  it('is offered in a chat\'s Agent Monitor, and not in an archived (read-only) chat', async () => {
    const { renderChatPane, chatSession, withProvider } = await chatHarness();
    withProvider();
    const plan = chatSession({ agentPlan: session.agentPlan });
    /** The opening tag of the Agent Monitor's Change plan button. */
    const button = (html: string) => {
      const rail = html.slice(html.indexOf('aria-label="Plan and sub-agents"'));
      const end = rail.indexOf('Change plan</button>');
      return end < 0 ? null : rail.slice(rail.lastIndexOf('<button', end), rail.indexOf('>', rail.lastIndexOf('<button', end)) + 1);
    };
    expect(button(renderChatPane(plan))).not.toBeNull();
    expect(button(renderChatPane(plan))).not.toContain('disabled=""');
    expect(button(renderChatPane(plan, { readOnly: true }))).toContain('disabled=""');
  });

  // Source pin, pending the plan-and-mode e2e journey: the prompt opens from a
  // click (pane state) and sending steers or sends through host calls; a server
  // render reaches none of it.
  it('pops up where questions do, in both the full chat and a wall window, and steers a running agent (source pin)', () => {
    const pane = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(pane).toMatch(/surface === 'transcript' && planChangeOpen && !question/);
    expect(pane).toMatch(/surface !== 'composer' && planChangeOpen && !question/);
    expect(pane).toMatch(/if \(streamingRef\.current\) \{\s*const updated = await window\.nekko\.steerChat\(sessionId, text\)/);
    expect(pane).toMatch(/await send\(text\);/);
  });
});

/** The real ChatPane at a pane wide enough for the Agent Monitor, in a fresh module graph. */
async function chatHarness() {
  vi.resetModules();
  vi.doUnmock('../store.js');
  await import('../tests/browserGlobals.js');
  const { liveStore } = await import('../tests/liveStore.js');
  const { elementWidthMock, paneWidth } = await import('../tests/paneWidth.js');
  vi.doMock('../store.js', (o) => liveStore(o as never));
  vi.doMock('../liveRuns.js', async (o) => ({ ...(await o<object>()), useLiveRun: () => undefined }));
  vi.doMock('./agent-console/useElementWidth.js', (o) => elementWidthMock(o));
  paneWidth.value = 1200;
  return import('../tests/renderChatPane.js');
}

it('lists sub-agents above the agent plan', () => {
  const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={session} streaming={false} />);
  expect(markup.indexOf('>Sub-agents<')).toBeGreaterThan(-1);
  expect(markup.indexOf('>Sub-agents<')).toBeLessThan(markup.indexOf('>Agent plan<'));
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
    const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={parallel} streaming={streaming} />);
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
    const paused = renderToStaticMarkup(<PlanRail sessionId="s" session={interrupted} streaming={false} />);
    expect(paused.match(/aria-label="Paused"/g)).toHaveLength(2);
    expect(paused).not.toContain('aria-label="Working"');
    expect(paused).toContain('M8 5v14M16 5v14');
    for (const running of [interrupted, { ...interrupted, activeRun: { startedAt: 1 } }]) {
      const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={running} streaming={running === interrupted} />);
      expect(markup.match(/aria-label="Working"/g)).toHaveLength(2);
    }
  });
});
