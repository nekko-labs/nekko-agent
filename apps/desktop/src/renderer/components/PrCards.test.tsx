import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const theme = vi.hoisted(() => ({ preset: 'autumn' as string | undefined }));
vi.mock('../store.js', () => ({ useStore: Object.assign(vi.fn((selector) => selector({ settings: { themePreset: theme.preset }, sessions: [], openPrPane: vi.fn() })), { getState: vi.fn() }) }));
vi.mock('../prPolling.js', () => ({ subscribePrPolling: () => () => {} }));
import type { PrInfo } from '@nekko-agent/shared';
import { PrCard, PrBadge } from './PrCard.js';
const url = 'https://github.com/o/r/pull/1';
const pr = { url, owner: 'o', repo: 'r', number: 1, title: 'A change', state: 'open', checks: 'pending', source: 'gh' } as PrInfo;
describe('PR milestones and live card', () => {
  it('keeps the created card historical even when live state is merged', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={{ ...pr, state: 'merged' }} event="created" sessionId="s" />);
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
  it('opens up for a live PR into the actions the composer used to carry', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event="created" sessionId="s" />);
    expect(markup).toContain('data-pr-actions');
    expect(markup).toContain('Approve');
    expect(markup).toContain('Decline');
    expect(markup).toContain('Review');
    expect(markup).toContain('data-pr-progress');
    // The strip the composer used to show is gone; its actions live on the card itself.
    expect(markup).not.toContain('pr-action-deck');
    expect(markup).not.toContain('Pending pull requests');
    expect(markup).not.toContain('Hide PR');
  });
  it('falls back to the created milestone when no sessionId is given', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event="created" />);
    expect(markup).toContain('PR created');
    expect(markup).not.toContain('data-pr-actions');
  });
  it.each([
    ['merge-requested', 'Merge requested'],
    ['auto-merge', 'Auto-merge enabled'],
    ['merge-queued', 'Added to merge queue'],
  ] as const)('a %s step says what was asked, never that the PR merged', (event, label) => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={{ ...pr, state: 'open' }} event={event} sessionId="s" />);
    expect(markup).toContain(label);
    expect(markup).not.toContain('PR merged');
    expect(markup).not.toContain('merged-wash');
    expect(markup).not.toContain('🎃');
    // A step never grows into the live card: that stays on the creation row.
    expect(markup).not.toContain('data-pr-actions');
  });
  it.each([
    ['created-draft', 'Draft PR created'],
    ['draft', 'Moved back to draft'],
    ['ready', 'Marked ready for review'],
    ['reopened', 'PR reopened'],
  ] as const)('labels the %s step', (event, label) => {
    expect(renderToStaticMarkup(<PrCard url={url} info={pr} event={event} />)).toContain(label);
  });
  it('a draft creation row still becomes the live card while the PR is open', () => {
    expect(renderToStaticMarkup(<PrCard url={url} info={pr} event="created-draft" sessionId="s" />)).toContain('data-pr-actions');
  });
  it('keeps the step label whole on a narrow column: only the title truncates', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event="merge-queued" />);
    expect(markup).toMatch(/class="[^"]*shrink-0 whitespace-nowrap[^"]*"[^>]*>Added to merge queue/);
    expect(markup).toMatch(/class="[^"]*truncate[^"]*"[^>]*>A change/);
  });
});
