import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrInfo } from '@nekko-agent/shared';
import { PrStatusIcon, SessionPrChip, primaryPr, prStatus, prTone } from './SessionPrChip.js';

const pr = (number: number, state: PrInfo['state'] = 'open', isDraft = false, createdAt?: string) =>
  ({ url: `https://github.com/o/r/pull/${number}`, owner: 'o', repo: 'r', number, title: `PR ${number}`, state, isDraft, createdAt } as PrInfo);

describe('session PR chip', () => {
  it('shows one PR as its state glyph and number, linking to it', () => {
    const markup = renderToStaticMarkup(<SessionPrChip prs={[pr(12, 'merged')]} />);
    expect(markup).toContain('data-pr-status="merged"');
    expect(markup).toContain('data-pr-glyph="merged"');
    expect(markup).toContain('href="https://github.com/o/r/pull/12"');
    expect(markup).toContain('aria-label="Pull request 12, merged"');
    expect(markup).toContain('#12<');
    expect(markup).toContain('color:var(--merged-ink)');
    expect(markup).not.toContain('<button');
  });

  it('shows the most relevant PR and a +N for the others', () => {
    const markup = renderToStaticMarkup(<SessionPrChip prs={[pr(1, 'merged'), pr(2), pr(3, 'closed')]} />);
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain('href="https://github.com/o/r/pull/2"');
    expect(markup).toContain('data-pr-status="open"');
    expect(markup).toContain('aria-label="3 pull requests from this chat"');
    expect(markup).toContain('>+2<');
  });

  it('renders nothing without PRs', () => {
    expect(renderToStaticMarkup(<SessionPrChip prs={[]} />)).toBe('');
  });

  it('maps each state to GitHub\'s glyph and hue', () => {
    const cases: Array<[PrInfo, string, string]> = [
      [pr(1), 'open', 'var(--success)'],
      [pr(1, 'open', true), 'draft', 'var(--ink-faint)'],
      [pr(1, 'merged'), 'merged', 'var(--merged-ink)'],
      [pr(1, 'closed'), 'closed', 'var(--danger)'],
      // A merged or closed PR that was a draft is merged or closed, not a draft.
      [pr(1, 'merged', true), 'merged', 'var(--merged-ink)'],
      [pr(1, 'closed', true), 'closed', 'var(--danger)'],
    ];
    for (const [p, status, tone] of cases) {
      expect(prStatus(p)).toBe(status);
      expect(prTone(p)).toBe(tone);
    }
    const glyphs = (['open', 'draft', 'merged', 'closed'] as const).map((s) => renderToStaticMarkup(<PrStatusIcon status={s} />));
    expect(new Set(glyphs).size).toBe(4);
  });
});

describe('primary PR', () => {
  it('prefers open, then draft, then merged, then closed', () => {
    expect(primaryPr([pr(1, 'closed'), pr(2, 'merged')])?.number).toBe(2);
    expect(primaryPr([pr(1, 'merged'), pr(2, 'open', true)])?.number).toBe(2);
    expect(primaryPr([pr(1, 'open', true), pr(2, 'open')])?.number).toBe(2);
    expect(primaryPr([pr(5, 'open'), pr(9, 'closed')])?.number).toBe(5);
  });

  it('picks the newest within a state, by when it was opened, else by number', () => {
    expect(primaryPr([pr(9, 'merged', false, '2026-10-01T00:00:00Z'), pr(3, 'merged', false, '2026-11-01T00:00:00Z')])?.number).toBe(3);
    expect(primaryPr([pr(3, 'open'), pr(9, 'open'), pr(5, 'open')])?.number).toBe(9);
  });

  it('keeps the first of equals and has nothing for no PRs', () => {
    const other = { ...pr(9), owner: 'x', url: 'https://github.com/x/r/pull/9' } as PrInfo;
    expect(primaryPr([pr(3), other])?.number).toBe(3);
    expect(primaryPr([])).toBeUndefined();
  });
});
