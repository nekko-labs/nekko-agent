import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanStep, PrInfo, Session } from '@nekko-agent/shared';
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector({}) }));
const linked = vi.hoisted(() => ({ links: null as Map<string, unknown> | null }));
vi.mock('../planStepLinks.js', async (original) => {
  const real = await original<typeof import('../planStepLinks.js')>();
  return { ...real, planStepLinks: (...args: Parameters<typeof real.planStepLinks>) => linked.links ?? real.planStepLinks(...args) };
});
import { PlanSheet } from './PlanSheet.js';
import { stylesheet } from '../tests/css.js';

const now = 1_800_000_000_000;
const step = (id: string, status: string, extra = {}) => ({ id, title: id, status: 'done', updatedAt: now, createdAt: now, verification: { status, ...extra } }) as PlanStep;
const render = (agentPlan: PlanStep[], prs: PrInfo[] = []) => renderToStaticMarkup(<PlanSheet sessionId="s" session={{ agentPlan, messages: [] } as unknown as Session} streaming prs={prs} initiallyOpen />);
const chips = (html: string, kind: string) => html.match(new RegExp(`data-plan-chip="${kind}"`, 'g'))?.length ?? 0;
afterEach(() => { vi.restoreAllMocks(); linked.links = null; });

describe('working and paused marks', () => {
  const active = { id: 'work', title: 'Working step', status: 'active', createdAt: now, updatedAt: now } as PlanStep;
  it('uses an aria-hidden SMIL ripple for working active steps', () => {
    const html = render([active]);
    expect(html).toContain('aria-label="Working"');
    expect(html).toContain('class="plan-working" aria-hidden="true"');
    expect(html).toContain('attributeName="r"');
    expect(html).toContain('repeatCount="indefinite"');
    expect(html).toContain('class="plan-working-still"');
    expect(html).not.toContain('M8 5v14M16 5v14');
  });
  it('keeps pause bars instead of a ripple for interrupted inactive runs', () => {
    const session = { agentPlan: [active], messages: [{ id: 'reply', role: 'assistant', content: 'Partial reply', interrupted: true, createdAt: now }] } as unknown as Session;
    const html = renderToStaticMarkup(<PlanSheet sessionId="s" session={session} streaming={false} prs={[]} initiallyOpen />);
    expect(html).toContain('aria-label="Paused"');
    expect(html).toContain('M8 5v14M16 5v14');
    expect(html).not.toContain('plan-working');
    expect(html).not.toContain('<animate');
  });
});

describe('verification chips', () => {
  it('shows only explicit reports, with device and detail, never a done step on its own', () => {
    const html = render([step('inspected', 'passed'), step('phone', 'blocked', { device: 'iPhone', detail: 'Waiting for pairing' }), { id: 'generic', title: 'generic', status: 'done', createdAt: now, updatedAt: now }]);
    expect(chips(html, 'verify')).toBe(2);
    expect(html).toContain('Verified');
    expect(html).toContain('Check blocked on iPhone');
    expect(html).toContain('Waiting for pairing');
    expect(html).toContain('not inferred from tool results');
  });
  it('gathers every Verify step and report under one Verify step, as sub-bullets', () => {
    const kinded = (id: string, kind: PlanStep['kind'], extra = {}) => ({ id, title: id, kind, status: 'done', createdAt: now, updatedAt: now, ...extra }) as PlanStep;
    const html = render([
      kinded('Fix the parser', 'build', { verification: { status: 'passed', device: 'Windows' } }),
      kinded('Run the tests', 'verify'),
      kinded('Screenshot it', 'verify', { status: 'active' }),
      kinded('Open the PR', 'ship', { status: 'pending' }),
    ]);
    expect(html.match(/data-plan-kind="verify"/g)).toHaveLength(1);
    expect(html.match(/data-plan-substep=/g)).toHaveLength(3);
    // The build step's report moved under Verify: its own row has no chip.
    const build = html.slice(html.indexOf('data-plan-step-id="Fix the parser"'), html.indexOf('data-plan-step-id="verify:all"'));
    expect(chips(build, 'verify')).toBe(0);
    expect(html).toContain('Verified on Windows');
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
  it('go under the Verify step in one row: failing first, passing folded into a count', () => {
    const html = render([step('first', 'passed'), { id: 'work', title: 'work', status: 'active', createdAt: now, updatedAt: now }, step('check', 'active')], [pr]);
    const row = html.slice(html.indexOf('data-plan-step-id="verify:all"'));
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

describe('step disclosure', () => {
  const plain = (id: string, status: string, note?: string) => ({ id, title: id, status, note, createdAt: now, updatedAt: now }) as PlanStep;
  const own = (patch: object) => ({ prs: [], artifacts: [], projects: [], subagents: [], ...patch });
  const tag = (html: string, id: string) => html.match(new RegExp(`<li[^>]*data-plan-step-id="${id}"[^>]*>[^]*?</li>`))![0];
  it('opens unfinished steps and the last finished step with results, and nothing on hover', () => {
    linked.links = new Map([
      ['shipped', own({ prs: ['https://github.com/o/r/pull/1'] })],
      ['report', own({ artifacts: [{ path: '/tmp/report.pdf', filename: 'report.pdf' }] })],
    ]);
    const html = render([plain('shipped', 'done', 'first PR'), plain('noted', 'done', 'a note'), plain('report', 'done', 'wrote it'), plain('now', 'active', 'working'), plain('later', 'pending')]);
    const open = (id: string) => /aria-expanded="true"/.test(tag(html, id)) && !/data-plan-more="" hidden=""/.test(tag(html, id));
    expect(open('shipped')).toBe(false);
    expect(open('noted')).toBe(false);
    expect(open('report')).toBe(true);
    expect(open('now')).toBe(true);
    // A step with nothing to show is a plain row, not a button.
    expect(tag(html, 'later')).not.toContain('aria-expanded');
    // Each step is its own button; the sheet no longer opens steps from tabindex or hover.
    expect(html.match(/class="plan-sheet-line plan-sheet-step-toggle" aria-expanded/g)).toHaveLength(4);
    expect(html).not.toContain('tabindex');
  });
  it('draws no card per step and opens no step from hover or focus on the sheet', () => {
    const rules: string[] = [];
    stylesheet('styles.css').walkRules(rule => { if (rule.selector.includes('plan-sheet-step')) rules.push(rule.selector + rule.toString()); });
    expect(rules.some(r => /\.plan-sheet:(hover|focus-within)/.test(r))).toBe(false);
    expect(rules.some(r => /plan-sheet-step[^-][^{]*\{[^}]*border:/.test(r))).toBe(false);
  });
});
