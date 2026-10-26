import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrInfo } from '@nekko-agent/shared';
import { PrProgress, progressAge, safeProgressLink } from './WorkProgress.js';

const now = 1_800_000_000_000;
describe('truthful chat progress', () => {
  it('does not hide missing PR reports', () => {
    expect(renderToStaticMarkup(<PrProgress url="https://github.com/o/r/pull/1" />)).toContain('Unknown: checks unavailable');
    expect(renderToStaticMarkup(<PrProgress url="https://github.com/o/r/pull/1" />)).toContain('Unknown: resolution counts unavailable');
  });
  it('labels stale reports independently of activity and GitHub update time', () => {
    expect(progressAge(now - 120_000, now)).toBe('2m ago · Stale');
    expect(progressAge(now, now)).toBe('0s ago');
    expect(progressAge(undefined, now)).toBe('Unknown update time');
    expect(progressAge(now + 1, now)).toBe('Unknown update time');
  });
  it('distinguishes finished/failing/pending/unknown and links review threads, not comment totals', () => {
    const info = { checkedAt: now, checkProgress: { total: 5, completed: 2, failing: 1, pending: 1, unknown: 1, items: [{ name: 'gate', state: 'pending', link: 'javascript:alert(1)' }] }, reviewThreads: { total: 4, resolved: 3, unresolved: 1 } } as PrInfo;
    const html = renderToStaticMarkup(<PrProgress url="https://github.com/o/r/pull/1?ignored=true" info={info} />);
    expect(html).toContain('3 of 5 finished');
    expect(html).toContain('1 failing');
    expect(html).toContain('1 unknown');
    expect(html).toContain('3 resolved · 1 unresolved');
    expect(html).toContain('href="https://github.com/o/r/pull/1/checks"');
    expect(html).toContain('href="https://github.com/o/r/pull/1/files"');
    expect(html).not.toContain('javascript:');
    expect(renderToStaticMarkup(<PrProgress url="https://github.com.evil/o/r/pull/1" info={info} />)).not.toContain('href=');
    // With the plan card showing CI, the PR card keeps only review threads.
    const slim = renderToStaticMarkup(<PrProgress url="https://github.com/o/r/pull/1" info={info} checks={false} />);
    expect(slim).not.toContain('CI checks');
    expect(slim).toContain('3 resolved · 1 unresolved');
  });
  it('treats an empty complete response as none, not unavailable', () => {
    const info = { checkProgress: { total: 0, completed: 0, failing: 0, pending: 0, unknown: 0, items: [] }, reviewThreads: { total: 0, resolved: 0, unresolved: 0 } } as unknown as PrInfo;
    const html = renderToStaticMarkup(<PrProgress url="https://github.com/o/r/pull/1" info={info} />);
    expect(html).toContain('None reported');
    expect(html).toContain('0 resolved · 0 unresolved');
  });
  it('rejects unsafe persisted links and credentials', () => {
    for (const url of ['javascript:alert(1)', 'file:///secret', '/relative', 'https://user:secret@github.com/a', 'data:text/html,x']) expect(safeProgressLink(url)).toBeUndefined();
    expect(safeProgressLink('https://example.com/proof.png')).toBe('https://example.com/proof.png');
  });
});
