import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const theme = vi.hoisted(() => ({ preset: 'autumn' as string | undefined }));
vi.mock('../store.js', () => ({ useStore: Object.assign(vi.fn((selector) => selector({ settings: { themePreset: theme.preset }, sessions: [], openPrPane: vi.fn() })), { getState: vi.fn() }) }));
import type { PrInfo } from '@nekko-agent/shared';
import { PrCard, PrActionDock, PrBadge } from './PrCard.js';
const url = 'https://github.com/o/r/pull/1';
const pr = { url, owner: 'o', repo: 'r', number: 1, title: 'A change', state: 'open', checks: 'pending', source: 'gh' } as PrInfo;
describe('PR milestones and composer actions', () => {
  it('keeps the created card historical even when live state is merged', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={{ ...pr, state: 'merged' }} event="created" />);
    expect(markup).toContain('PR created');
    expect(markup).not.toContain('Approve');
    expect(markup).not.toContain('Merge</button>');
    expect(markup).not.toContain('PR merged');
  });
  it.each(['closed', 'merged'] as const)('renders the %s milestone without actions', (event) => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event={event} />);
    expect(markup).toContain(`PR ${event}`);
    expect(markup).not.toContain('<button');
  });
  it('colours the merged banner from theme tokens, not fixed light violets', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={{ ...pr, state: 'merged' }} event="merged" />);
    expect(markup).toContain('var(--merged-wash)');
    expect(markup).toContain('var(--merged-line)');
    expect(markup).toContain('color:var(--merged-ink)');
    // Light violets only read on dark paper; on light paper they vanish.
    expect(markup).not.toMatch(/violet-(50|100|200)|#c084fc|rgba\(147,\s*51,\s*234/);
  });
  it('colours the merged badge from theme tokens', () => {
    const markup = renderToStaticMarkup(<PrBadge prs={[{ ...pr, state: 'merged' }]} />);
    expect(markup).toContain('var(--merged-chip)');
    expect(markup).toContain('var(--merged-ink)');
    expect(markup).not.toContain('#c084fc');
  });
  it('celebrates merges with static decorative autumn confetti', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event="merged" />);
    expect(markup).toContain('🎃');
    expect(markup).toContain('🍁');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('animate-pulse');
    expect(markup).not.toContain('✦');
    expect(renderToStaticMarkup(<PrCard url={url} info={pr} />)).not.toContain('🎃');
  });
  it('removes seasonal decorations when switching to another theme', () => {
    theme.preset = 'autumn';
    expect(renderToStaticMarkup(<PrCard url={url} event="merged" />)).toContain('🎃');
    theme.preset = 'ember';
    expect(renderToStaticMarkup(<PrCard url={url} event="merged" />)).not.toContain('🎃');
    theme.preset = 'autumn';
  });
  it('places actions and a non-destructive hide button on the open dock', () => {
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr]} urls={[url]} />);
    expect(markup).toContain('Pending pull requests');
    expect(markup).toContain('Approve');
    expect(markup).toContain('Decline');
    expect(markup).toContain('Review');
    expect(markup).toContain('Hide PR o/r#1');
    expect(markup).toContain('does not close the PR');
  });
  it('uses an ownership-scoped deck with actions beside the PR details', () => {
    const second = { ...pr, url: 'https://github.com/o/r/pull/2', number: 2 };
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr, second]} urls={[url]} />);
    expect(markup).toContain('pr-action-deck');
    expect(markup.match(/data-pr-actions=/g)).toHaveLength(1);
    expect(markup).not.toContain(second.url);
    expect(markup).not.toContain('mb-2');
    expect(markup).not.toContain('mt-1');
    expect(markup).toContain('justify-end gap-0');
    expect(markup).toContain('</p></div><div class="flex max-w-[55%]');
  });
  it('opens upward: cards render above the toggle that sits on the footer divider', () => {
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr]} urls={[url]} />);
    expect(markup.indexOf('data-pr-actions=')).toBeLessThan(markup.indexOf('class="pr-deck-toggle"'));
    expect(markup).toContain('data-floating="false"');
    expect(renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr]} urls={[url]} floating />)).toContain('data-floating="true"');
  });
  it.each(['merged', 'closed'] as const)('automatically collapses a %s PR in the dock', (state) => {
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[{ ...pr, state }]} urls={[url]} />);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('1 pull request');
    expect(markup).not.toContain('data-pr-actions');
  });
  it('expands mixed statuses while keeping resolved PRs out of actions', () => {
    const second = { ...pr, url: 'https://github.com/o/r/pull/2', number: 2, state: 'merged' as const };
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr, second]} urls={[url, second.url]} />);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('2 pull requests');
    expect(markup.match(/data-pr-actions=/g)).toHaveLength(1);
  });
});
