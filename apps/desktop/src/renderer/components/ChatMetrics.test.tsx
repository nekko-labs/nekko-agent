import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import type { ContextBundle } from '@nekko-agent/shared';
import { ContextGauge, EffortSlider, effortRungs, formatContextTokens } from './ChatMetrics.js';

describe('effort slider', () => {
  const metadata = { levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })), default: 'medium' };
  it('uses only the provider choices and default', () => {
    expect(effortRungs('normal', 'claude-opus-5-5', metadata)).toEqual({ options: ['low', 'medium', 'high', 'xhigh', 'max'], index: 1, shown: 'Medium' });
    const html = renderToStaticMarkup(<EffortSlider modelId="claude-opus-5-5" metadata={metadata} />);
    expect(html).toContain('data-effort-count="5"');
    expect(html).toContain('data-effort-index="1"');
    expect(html).toContain('aria-label="Reasoning effort: Medium"');
    expect(html).not.toContain('border-line');
  });
  it('shows the chat effort when given a chat', () => {
    const html = renderToStaticMarkup(<EffortSlider modelId="claude-opus-5-5" metadata={metadata} session={{ id: 'c', effort: 'max' }} />);
    expect(html).toContain('data-effort-index="4"');
    expect(html).toContain('Reasoning effort for this chat');
  });
  it.each(['claude-opus-5-5', 'llama3', 'gpt-5'])('does not guess choices for %s without metadata', (modelId) => {
    expect(effortRungs('normal', modelId)).toEqual({ options: [], index: -1, shown: 'Unavailable' });
    const html = renderToStaticMarkup(<EffortSlider modelId={modelId} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Reasoning effort: Unavailable');
    expect(html).not.toContain('Normal');
  });
  it('labels future provider levels without a hardcoded map entry', () => {
    expect(effortRungs('ultra', 'new-model', { levels: [{ effort: 'ultra' }] })).toEqual({ options: ['ultra'], index: 0, shown: 'ultra' });
  });
  it('does not present the legacy normal sentinel as an advertised choice', () => {
    expect(effortRungs('normal', 'new-model', { levels: [{ effort: 'high' }] })).toEqual({ options: ['high'], index: -1, shown: 'Provider default' });
    expect(effortRungs('normal', 'new-model', { levels: [] })).toEqual({ options: [], index: -1, shown: 'Unavailable' });
  });
});

describe('context token formatting', () => {
  it.each([[999, '999'], [1000, '1.0k'], [177000, '177k'], [1000000, '1m'], [1500000, '1.5m'], [2000000, '2m']])('formats %i as %s', (tokens, label) => {
    expect(formatContextTokens(Number(tokens))).toBe(label);
  });
  it('shows a million-token window as 1m while retaining exact accessible counts', () => {
    const html = renderToStaticMarkup(<ContextGauge bundle={null} draftTokens={177000} contextWindow={1000000} windowReported />);
    expect(html).toContain('177k / 1m');
    expect(html).not.toContain('1000k');
    expect(html).toContain('177,000 of 1,000,000 tokens in use');
  });
  it('shows what Claude Code reported for a Claude Agent chat instead of the bundle estimate', () => {
    const bundle = { items: [{ id: 'c', source: 'conversation', label: 'Conversation', tokens: 3000, included: true }], contextWindow: 1000000 } as unknown as ContextBundle;
    const html = renderToStaticMarkup(<ContextGauge bundle={bundle} reported={{ used: 42000, window: 200000 }} />);
    expect(html).toContain('42k / 200k');
    expect(html).not.toContain('/ ~');
    expect(html).toContain('Reported by Claude Code after its last model call.');
  });
  it.each([[0, 'success'], [599999, 'success'], [600000, 'warning'], [849999, 'warning'], [850000, 'danger'], [1000000, 'danger']])
    ('retains the filled gauge at %i tokens with %s tone', (tokens, tone) => {
      const html = renderToStaticMarkup(<ContextGauge bundle={null} draftTokens={Number(tokens)} contextWindow={1000000} />);
      expect(html).toContain(` / ~1m`);
      // The ring, filled by its dash so the stroke repaints and nothing re-lays out.
      expect(html).toContain(`stroke="var(--${tone})"`);
      expect(html).toContain(`stroke-dasharray="${Number(tokens) / 10000} 100"`);
      expect(html).not.toContain('transition-[width]');
    });
});

describe('dials', () => {
  it('sweeps 240° open at the bottom, with the large arc past halfway', async () => {
    const { arcPath } = await import('./ModeViews.js');
    // Start at 150° (lower left), so an empty arc starts and ends there.
    expect(arcPath(20, 2, 0)).toBe('M 2.21 14.50 A 9 9 0 0 1 2.21 14.50');
    // Half the sweep is straight up; the full sweep ends lower right.
    expect(arcPath(20, 2, 0.5)).toBe('M 2.21 14.50 A 9 9 0 0 1 10.00 1.00');
    expect(arcPath(20, 2, 1)).toBe('M 2.21 14.50 A 9 9 0 1 1 17.79 14.50');
  });
  it('draws the context window as a ring with the count', () => {
    const html = renderToStaticMarkup(<ContextGauge bundle={null} draftTokens={90000} contextWindow={100000} windowReported />);
    expect(html).toContain('stroke-dasharray="90 100"');
    expect(html).toContain('90k / 100k');
  });
});
