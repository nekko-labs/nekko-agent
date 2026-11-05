import { describe, expect, it } from 'vitest';
import type { PrInfo } from '@nekko-agent/shared';
import { isPrUrl, prStatus } from './PrLinkChip.js';

const pr = (patch: Partial<PrInfo>): PrInfo => ({ url: '', owner: 'o', repo: 'r', number: 1, title: 't', state: 'open', isDraft: false, additions: 0, deletions: 0, changedFiles: 0, checks: 'none', source: 'gh', ...patch });

describe('PR link chip', () => {
  it('recognises PR URLs only', () => {
    expect(isPrUrl('https://github.com/nekko-labs/nekko-agent/pull/1663')).toBe(true);
    expect(isPrUrl('https://github.com/nekko-labs/nekko-agent/pull/1663/')).toBe(true);
    expect(isPrUrl('https://github.com/nekko-labs/nekko-agent/pull/1663/files')).toBe(false);
    expect(isPrUrl('https://github.com/nekko-labs/nekko-agent/issues/1663')).toBe(false);
    expect(isPrUrl('https://example.com/a/b/pull/1')).toBe(false);
  });

  it('maps a PR to the state GitHub shows', () => {
    expect(prStatus(null)).toBe('unknown');
    expect(prStatus(pr({}))).toBe('open');
    expect(prStatus(pr({ isDraft: true }))).toBe('draft');
    expect(prStatus(pr({ state: 'merged' }))).toBe('merged');
    expect(prStatus(pr({ state: 'closed' }))).toBe('closed');
  });
});
