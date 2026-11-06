import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SubscriptionLimits } from '@nekko-agent/shared';
import { ProviderUsageMeters } from './ProviderUsageMeters.js';

const limits: SubscriptionLimits = { updatedAt: 1000, staleAfterMs: 1000, windows: [
  { id: 'session', label: '5 hours', scope: 'session', usedPercent: 62, resetAt: 9000000, status: 'allowed' },
  { id: 'weekly', label: 'Weekly', scope: 'weekly', usedPercent: 92, resetAt: 9000000, status: 'warning' },
] };

describe('provider usage meters', () => {
  it('renders every reported window with accessible usage, status, reset detail and proportional fill', () => {
    const out = renderToStaticMarkup(<ProviderUsageMeters limits={limits} answered now={1500} />);
    expect(out.match(/role="meter"/g)).toHaveLength(2);
    expect(out).toContain('aria-label="5 hours usage"');
    expect(out).toContain('aria-valuenow="62"');
    expect(out).toContain('width:62%');
    expect(out).toContain('92% used · Warning');
    expect(out).toContain('Resets');
    expect(out).not.toContain('stale');
  });
  it('distinguishes loading, missing and stale data without claiming zero usage', () => {
    expect(renderToStaticMarkup(<ProviderUsageMeters answered={false} />)).toContain('Reading usage limits…');
    expect(renderToStaticMarkup(<ProviderUsageMeters answered />)).toContain('Usage limits not reported');
    expect(renderToStaticMarkup(<ProviderUsageMeters answered limits={{ ...limits, windows: [] }} />)).not.toContain('role="meter"');
    const out = renderToStaticMarkup(<ProviderUsageMeters limits={limits} answered now={3000} />);
    expect(out).toContain('Last reported usage · stale');
    expect(out).toContain('62% used, stale');
  });
  it('clamps bars and accessibility values, keeps reported values, and rejects nonfinite usage', () => {
    const out = renderToStaticMarkup(<ProviderUsageMeters limits={{ ...limits, windows: [
      { ...limits.windows[0], usedPercent: 112, status: 'rate_limited' },
      { ...limits.windows[1], usedPercent: NaN },
    ] }} answered now={1500} />);
    expect(out.match(/role="meter"/g)).toHaveLength(1);
    expect(out).toContain('width:100%');
    expect(out).toContain('aria-valuenow="100"');
    expect(out).toContain('112% used · Limited');
  });
});
