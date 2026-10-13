import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector({ sessions: [], openChatPane: () => {}, settings: {} }) }));
import { PlanRail, appendPlanChangeRequest, PLAN_CHANGE_REQUEST } from './PlanRail.js';

const session = { agentPlan: [{ id: 'one', title: 'Inspect code', status: 'active' }] } as Session;
describe('change plan action', () => {
  it('offers an editable follow-up action instead of passive instructions', () => {
    const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={session} streaming onChangePlan={() => {}} />);
    expect(markup).toContain('Change plan</button>');
    expect(markup).not.toContain('Want to change the approach?');
  });
  it('disables the action when editing is unavailable and hides it without a plan', () => {
    expect(renderToStaticMarkup(<PlanRail sessionId="s" session={session} streaming={false} />)).toContain('disabled=""');
    expect(renderToStaticMarkup(<PlanRail sessionId="s" session={null} streaming={false} />)).not.toContain('Change plan');
  });
  it('preserves an existing draft and adds space for the requested adjustment', () => {
    expect(appendPlanChangeRequest('My unsent question')).toBe(`My unsent question\n\n${PLAN_CHANGE_REQUEST}`);
    expect(appendPlanChangeRequest('')).toBe(PLAN_CHANGE_REQUEST);
  });
});

it('lists sub-agents above the agent plan', () => {
  const markup = renderToStaticMarkup(<PlanRail sessionId="s" session={session} streaming={false} />);
  expect(markup.indexOf('>Sub-agents<')).toBeGreaterThan(-1);
  expect(markup.indexOf('>Sub-agents<')).toBeLessThan(markup.indexOf('>Agent plan<'));
});
