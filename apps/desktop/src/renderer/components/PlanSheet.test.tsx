import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueInfo, PlanStep, PrInfo, Session, SessionSummary } from '@nekko-agent/shared';
const state = vi.hoisted(() => ({ sessions: [] as unknown[] }));
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector(state) }));
const linked = vi.hoisted(() => ({ links: null as Map<string, unknown> | null }));
vi.mock('../planStepLinks.js', async (original) => {
  const real = await original<typeof import('../planStepLinks.js')>();
  return { ...real, planStepLinks: (...args: Parameters<typeof real.planStepLinks>) => linked.links ?? real.planStepLinks(...args) };
});
import { PlanSheet, issueLook, subagentCardState } from './PlanSheet.js';
import { stylesheet } from '../tests/css.js';

const now = 1_800_000_000_000;
const step = (id: string, status: string, extra = {}) => ({ id, title: id, status: 'done', updatedAt: now, createdAt: now, verification: { status, ...extra } }) as PlanStep;
const render = (agentPlan: PlanStep[], prs: PrInfo[] = []) => renderToStaticMarkup(<PlanSheet sessionId="s" session={{ agentPlan, messages: [] } as unknown as Session} streaming prs={prs} initiallyOpen />);
const chips = (html: string, kind: string) => html.match(new RegExp(`data-plan-chip="${kind}"`, 'g'))?.length ?? 0;
afterEach(() => { vi.restoreAllMocks(); linked.links = null; state.sessions = []; });

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

describe('verification marks', () => {
  const marks = (html: string) => html.match(/data-plan-check=/g)?.length ?? 0;
  it('shows only explicit reports, on the bullet with device and detail, never as a chip', () => {
    const html = render([step('inspected', 'passed'), step('phone', 'blocked', { device: 'iPhone', detail: 'Waiting for pairing' }), { id: 'generic', title: 'generic', status: 'done', createdAt: now, updatedAt: now }]);
    expect(chips(html, 'verify')).toBe(0);
    // Exactly one mark per explicit report, on its original step.
    expect(marks(html)).toBe(2);
    expect(html).toContain('aria-label="Verified"');
    expect(html).toContain('aria-label="Check blocked on iPhone"');
    expect(html).toContain('Waiting for pairing');
    expect(html).toContain('not inferred from tool results');
  });
  it('shows the working ripple while a check runs, even on a done step, and only then', () => {
    expect(render([step('running', 'active')])).toContain('class="plan-working"');
    for (const status of ['pending', 'passed', 'failed', 'blocked']) expect(render([step('t', status)])).not.toContain('class="plan-working"');
  });
  it('keeps checks and reports on their original flat rows in published order', () => {
    const kinded = (id: string, kind: PlanStep['kind'], extra = {}) => ({ id, title: id, kind, status: 'done', createdAt: now, updatedAt: now, ...extra }) as PlanStep;
    const html = render([
      kinded('Fix the parser', 'build', { verification: { status: 'passed', device: 'Windows' } }),
      kinded('Run the tests', 'verify'),
      kinded('Screenshot it', 'verify', { status: 'active' }),
      kinded('Open the PR', 'ship', { status: 'pending' }),
    ]);
    expect(html).not.toContain('data-plan-kind');
    expect(html).not.toContain('data-plan-substep');
    expect(html).not.toContain('verify:all');
    expect(html).not.toContain('Check the work');
    expect(html.match(/data-plan-step-id="([^"]+)"/g)).toEqual([
      'data-plan-step-id="Fix the parser"', 'data-plan-step-id="Run the tests"',
      'data-plan-step-id="Screenshot it"', 'data-plan-step-id="Open the PR"',
    ]);
    expect(html).toContain('2 of 4 done');
    const build = html.slice(html.indexOf('data-plan-step-id="Fix the parser"'), html.indexOf('data-plan-step-id="Run the tests"'));
    expect(marks(build)).toBe(1);
    expect(html).toContain('Verified on Windows');
    expect(chips(html, 'verify')).toBe(0);
  });
  it('marks waiting reports stale and leaves finished ones unstale', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now + 180_000);
    for (const status of ['passed', 'failed', 'blocked', 'unknown']) expect(render([step('t', status)])).not.toContain(' · Stale');
    for (const status of ['active', 'pending']) expect(render([step('w', status)])).toContain('3m ago · Stale');
  });
  it('opens only safe evidence links from the bullet', () => {
    expect(render([step('bad', 'passed', { evidenceUrl: 'javascript:alert(1)' })])).not.toContain('open evidence');
    expect(render([step('ok', 'passed', { evidenceUrl: 'https://example.com/proof.png' })])).toMatch(/<button[^>]*class="plan-sheet-mark[^>]*aria-label="Verified, open evidence"/);
  });
});

describe('CI chips', () => {
  const pr = { url: 'https://github.com/o/r/pull/9', number: 9, state: 'open', checks: 'failing', checkProgress: { total: 4, completed: 2, pending: 1, failing: 1, unknown: 0, items: [
    { name: 'build', state: 'completed', link: null }, { name: 'gate', state: 'pending', link: null }, { name: 'lint', state: 'completed', link: null }, { name: 'e2e', state: 'failing', link: null },
  ] } } as unknown as PrInfo;
  it('go under the last reported step in one row: failing first, passing folded into a count', () => {
    const html = render([step('first', 'passed'), { id: 'work', title: 'work', status: 'active', createdAt: now, updatedAt: now }, step('check', 'active')], [pr]);
    const row = html.slice(html.indexOf('data-plan-step-id="check"'));
    expect(chips(row, 'ci')).toBe(3);
    expect(row.indexOf('e2e')).toBeLessThan(row.indexOf('gate'));
    expect(row).toContain('CI: 2 passed');
    expect(row).toContain('CI: e2e');
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
  it('keeps results under their related check instead of merging checks together', () => {
    linked.links = new Map([
      ['unit', own({ prs: ['https://github.com/o/r/pull/1'] })],
      ['visual', own({ artifacts: [{ path: '/tmp/evidence.png', filename: 'evidence.png' }] })],
    ]);
    const html = render([
      { ...plain('unit', 'done', 'Tests passed'), kind: 'verify' },
      { ...plain('visual', 'active', 'Inspect the pixels'), kind: 'verify' },
    ]);
    expect(html).toContain('1 of 2 done');
    expect(tag(html, 'unit')).toContain('PR #1');
    expect(tag(html, 'unit')).not.toContain('evidence.png');
    expect(tag(html, 'visual')).toContain('File: evidence.png');
    expect(tag(html, 'visual')).not.toContain('PR #1');
    expect(html).not.toContain('data-plan-substep');
  });
  it('draws no card per step and opens no step from hover or focus on the sheet', () => {
    const rules: string[] = [];
    stylesheet('styles.css').walkRules(rule => { if (rule.selector.includes('plan-sheet-step')) rules.push(rule.selector + rule.toString()); });
    expect(rules.some(r => /\.plan-sheet:(hover|focus-within)/.test(r))).toBe(false);
    expect(rules.some(r => /plan-sheet-step[^-][^{]*\{[^}]*border:/.test(r))).toBe(false);
  });
});

describe('sub-agent cards', () => {
  const kids = () => {
    state.sessions = [
      { id: 'done', parentSessionId: 's', title: 'Finished helper', createdAt: now },
      { id: 'kid', parentSessionId: 's', title: 'Trace lookup', createdAt: now, activeRun: { startedAt: now } },
      { id: 'other', parentSessionId: 'other-parent', title: 'Unrelated helper', activeRun: {} },
    ];
  };
  const cards = (html: string) => html.slice(html.indexOf('data-plan-subagents'));
  it('shows every child as a live card at the bottom of the open plan, working first', () => {
    kids();
    const html = render([{ id: 'build', title: 'Build', status: 'done', createdAt: now, updatedAt: now }]);
    // Below the steps, not above the head.
    expect(html.indexOf('data-plan-subagents')).toBeGreaterThan(html.indexOf('</ol>'));
    const row = cards(html);
    expect(row).toContain('data-subagent-card="kid" data-status="working"');
    expect(row).toContain('data-subagent-card="done" data-status="done"');
    expect(row.indexOf('Trace lookup')).toBeLessThan(row.indexOf('Finished helper'));
    expect(row).toContain('aria-label="Trace lookup, Working. Open sub-agent"');
    expect(row).not.toContain('Unrelated helper');
    expect(html).not.toContain('data-plan-running-subagents');
    // The row leads with its own label and the agents glyph.
    expect(row.indexOf('plan-sheet-agents-head')).toBeLessThan(row.indexOf('data-subagent-card'));
    expect(row).toContain('data-gf-icon="bots"');
  });
  it('keeps the cards on the folded plan', () => {
    kids();
    const html = renderToStaticMarkup(<PlanSheet sessionId="s" session={{ agentPlan: [{ id: 'build', title: 'Build', status: 'active', createdAt: now, updatedAt: now }], messages: [] } as unknown as Session} streaming prs={[]} initiallyOpen={false} />);
    expect(html).toContain('data-folded');
    expect(cards(html)).toContain('data-subagent-card="kid"');
    expect(html).not.toContain('data-plan-chip="subagents"');
  });
});

describe('subagentCardState', () => {
  const child = { id: 'c', title: 'T', createdAt: now } as SessionSummary;
  it('reads a live child as working and an idle one as done', () => {
    expect(subagentCardState(child, true).status).toBe('working');
    expect(subagentCardState(child, false)).toEqual({ status: 'done', detail: '' });
  });
  it('reads a stalled child as stopped', () => {
    expect(subagentCardState({ ...child, stalled: true } as SessionSummary, false).status).toBe('error');
  });
});

describe('chip type labels', () => {
  it('identifies PRs, tasks, files and previews without a tooltip', () => {
    linked.links = new Map([['build', {
      prs: ['https://github.com/o/r/pull/9'], projects: [{ url: 'https://github.com/o/r/issues/4', label: 'o/r#4' }], subagents: [],
      artifacts: [{ path: '/tmp/report.html', filename: 'report.html' }, { path: '/tmp/preview.html', filename: 'preview.html', live: { url: 'http://localhost:3000/demo', host: 'localhost:3000', route: '/demo' } }],
    }]]);
    const html = render([{ id: 'build', title: 'Build', status: 'active', createdAt: now, updatedAt: now }]);
    for (const label of ['PR #9', 'Task: o/r#4', 'File: report.html', 'Preview: localhost:3000/demo']) expect(html).toContain(label);
  });
});

describe('task chips', () => {
  const issue = (state: 'open' | 'closed', stateReason: string | null = null) => ({ kind: 'issue', url: 'u', owner: 'o', repo: 'r', number: 1, title: 't', state, stateReason }) as IssueInfo;
  it('draws a GitHub issue as GitHub does: green open, purple done, grey not planned', () => {
    expect(issueLook(issue('open'))).toMatchObject({ icon: 'record', tone: 'var(--success)' });
    expect(issueLook(issue('closed', 'completed'))).toMatchObject({ icon: 'check-circle', tone: 'var(--merged-ink)' });
    expect(issueLook(issue('closed'))).toMatchObject({ icon: 'check-circle', label: 'Done' });
    expect(issueLook(issue('closed', 'not_planned'))).toMatchObject({ icon: 'ban', tone: 'var(--ink-faint)' });
  });
});
