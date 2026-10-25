import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlanStep, PrInfo } from '@nekko-agent/shared';
import { PrProgress, VerificationChecklist, progressAge, safeProgressLink } from './WorkProgress.js';

const now = 1_800_000_000_000;
const step = (id: string, status: string, extra = {}) => ({ id, title: id, status: 'done', updatedAt: now, createdAt: now, verification: { status, ...extra } }) as PlanStep;
describe('truthful chat progress', () => {
  it('counts explicit passes only, not done, skipped, active or blocked', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(<VerificationChecklist steps={[step('inspected', 'passed'), step('captured', 'active'), step('phone', 'blocked', { device: 'iPhone', detail: 'Waiting for pairing' }), { id: 'generic', title: 'done', status: 'done', createdAt: now, updatedAt: now }]} />);
    expect(html).toContain('1 of 3 passed');
    expect(html).toContain('1 blocked');
    expect(html).toContain('On iPhone');
    expect(html).toContain('Waiting for pairing');
    expect(html).toContain('not inferred from tool completion');
    vi.restoreAllMocks();
  });
  it('does not invent a checklist or hide missing reports', () => {
    expect(renderToStaticMarkup(<VerificationChecklist />)).toBe('');
    expect(renderToStaticMarkup(<VerificationChecklist steps={[{ ...step('generic', 'active'), verification: undefined }]} />)).toContain('Unknown: no checklist published');
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
