import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanStep, PrInfo, Session } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector({}) }));
import { PlanSheet } from './PlanSheet.js';

const now = 1_800_000_000_000;
const step = (id: string, status: string, extra = {}) => ({ id, title: id, status: 'done', updatedAt: now, createdAt: now, verification: { status, ...extra } }) as PlanStep;
const render = (agentPlan: PlanStep[], prs: PrInfo[] = []) => renderToStaticMarkup(<PlanSheet sessionId="s" session={{ agentPlan, messages: [] } as unknown as Session} streaming prs={prs} initiallyOpen />);
const chips = (html: string, kind: string) => html.match(new RegExp(`data-plan-chip="${kind}"`, 'g'))?.length ?? 0;
afterEach(() => vi.restoreAllMocks());

describe('verification chips', () => {
  it('shows only explicit reports, with device and detail, never a done step on its own', () => {
    const html = render([step('inspected', 'passed'), step('phone', 'blocked', { device: 'iPhone', detail: 'Waiting for pairing' }), { id: 'generic', title: 'generic', status: 'done', createdAt: now, updatedAt: now }]);
    expect(chips(html, 'verify')).toBe(2);
    expect(html).toContain('Verified');
    expect(html).toContain('Check blocked on iPhone');
    expect(html).toContain('Waiting for pairing');
    expect(html).toContain('not inferred from tool results');
  });
  it('marks waiting reports stale and leaves finished ones unstale', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now + 180_000);
    for (const status of ['passed', 'failed', 'blocked', 'unknown']) expect(render([step('t', status)])).not.toContain(' · Stale');
    for (const status of ['active', 'pending']) expect(render([step('w', status)])).toContain('3m ago · Stale');
  });
  it('opens only safe evidence links', () => {
    expect(render([step('bad', 'passed', { evidenceUrl: 'javascript:alert(1)' })])).toMatch(/data-plan-chip="verify" disabled=""/);
    expect(render([step('ok', 'passed', { evidenceUrl: 'https://example.com/proof.png' })])).not.toMatch(/data-plan-chip="verify" disabled=""/);
  });
});

describe('CI chips', () => {
  const pr = { url: 'https://github.com/o/r/pull/9', number: 9, state: 'open', checks: 'failing', checkProgress: { total: 4, completed: 2, pending: 1, failing: 1, unknown: 0, items: [
    { name: 'build', state: 'completed', link: null }, { name: 'gate', state: 'pending', link: null }, { name: 'lint', state: 'completed', link: null }, { name: 'e2e', state: 'failing', link: null },
  ] } } as unknown as PrInfo;
  it('go under the last verification step in one row: failing first, passing folded into a count', () => {
    const html = render([step('first', 'passed'), { id: 'work', title: 'work', status: 'active', createdAt: now, updatedAt: now }, step('check', 'active')], [pr]);
    const row = html.slice(html.indexOf('data-plan-step-id="check"'));
    expect(chips(row, 'ci')).toBe(3);
    expect(row.indexOf('e2e')).toBeLessThan(row.indexOf('gate'));
    expect(row).toContain('2 passed');
    expect(chips(html, 'ci')).toBe(3);
  });
  it('fall back to the running step without a verification step, and skip closed PRs', () => {
    const plan = [{ id: 'a', title: 'a', status: 'done', createdAt: now, updatedAt: now }, { id: 'b', title: 'b', status: 'active', createdAt: now, updatedAt: now }] as PlanStep[];
    expect(render(plan, [pr]).slice(render(plan, [pr]).indexOf('data-plan-step-id="b"'))).toContain('2 passed');
    expect(chips(render(plan, [{ ...pr, state: 'merged' }]), 'ci')).toBe(0);
  });
});
