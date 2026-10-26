import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectivityNotice } from '@nekko-agent/shared';
import { ConnectivityNotices, mergeConnectivityNotices } from './ConnectivityNotices.js';
const notice = (id: string, createdAt: number): ConnectivityNotice => ({ id, createdAt, kind: 'lost', content: 'Internet reachability lost. Saved progress is retained.' });
describe('Connectivity notices', () => {
  it('renders timestamps as display-only notices, not messages or resume controls', () => {
    const html = renderToStaticMarkup(<ConnectivityNotices notices={[notice('n1', 1781690420000)]} />);
    expect(html).toContain('aria-label="Internet connectivity notices"');
    expect(html).toContain('<time ');
    expect(html).toContain('dateTime="2026-06-17T10:00:20.000Z"');
    expect(html).toContain('Saved progress is retained');
    expect(html).not.toContain('<button');
    expect(renderToStaticMarkup(<ConnectivityNotices notices={[]} />)).toBe('');
  });
  it('deduplicates persisted/live incognito notices, orders timestamps and bounds history', () => {
    expect(mergeConnectivityNotices([notice('a', 2)], [notice('a', 2), notice('b', 1)]).map(n => n.id)).toEqual(['b', 'a']);
    const many = Array.from({ length: 105 }, (_, i) => notice(String(i), i));
    const kept = mergeConnectivityNotices(undefined, many);
    expect(kept).toHaveLength(100);
    expect(kept[0].id).toBe('5');
    expect(mergeConnectivityNotices([notice('bad', NaN)])).toEqual([]);
  });
});
