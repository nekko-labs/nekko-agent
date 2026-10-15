import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import { ContextGauge, EffortSlider, effortRungs, formatContextTokens } from './ChatMetrics.js';

describe('effort slider', () => {
  it('puts Low at the left end for Opus 5.5 and marks its default on the Medium rung', () => {
    expect(effortRungs('normal', 'claude-opus-5-5')).toEqual({ options: ['low', 'normal', 'high', 'xhigh', 'max'], index: 1, shown: 'Default · Medium' });
    expect(effortRungs('low', 'claude-opus-5-5')).toMatchObject({ index: 0, shown: 'Low' });
    expect(effortRungs('max', 'claude-opus-5-5')).toMatchObject({ index: 4, shown: 'Max' });
    // The default-first slider rendered with no settings loaded.
    const html = renderToStaticMarkup(<EffortSlider modelId="claude-opus-5-5" />);
    expect(html).toContain('max="4"');
    expect(html).toContain('value="1"');
  });
  it('treats picking the default rung explicitly as the default', () => {
    expect(effortRungs('medium', 'claude-opus-5-5').shown).toBe('Default · Medium');
    expect(effortRungs('high', 'claude-opus-5')).toMatchObject({ options: ['low', 'medium', 'normal', 'xhigh', 'max'], index: 2, shown: 'Default · High' });
    expect(effortRungs('medium', 'claude-opus-5')).toMatchObject({ index: 1, shown: 'Medium' });
  });
  it('leaves non-native scales unchanged', () => {
    expect(effortRungs('normal', 'llama3')).toEqual({ options: ['low', 'normal', 'high'], index: 1, shown: 'Normal' });
    expect(effortRungs('high', 'gpt-5')).toEqual({ options: ['low', 'medium', 'normal', 'high'], index: 3, shown: 'High' });
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
  it.each([[0, 'success'], [599999, 'success'], [600000, 'warning'], [849999, 'warning'], [850000, 'danger'], [1000000, 'danger']])
    ('retains the filled gauge at %i tokens with %s tone', (tokens, tone) => {
      const html = renderToStaticMarkup(<ContextGauge bundle={null} draftTokens={Number(tokens)} contextWindow={1000000} />);
      expect(html).toContain(` / ~1m`);
      expect(html).toContain(`color-mix(in srgb, var(--${tone}) 28%, transparent)`);
      expect(html).toContain(`color-mix(in srgb, var(--${tone}) 12%, var(--surface-2))`);
      expect(html).toContain('absolute inset-0 origin-left transition-transform duration-300');
      expect(html).toContain(`transform:scaleX(${Number(tokens) / 1000000})`);
      expect(html).not.toContain('transition-[width]');
    });
});
