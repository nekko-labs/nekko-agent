import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContinueAtReset } from './ContinueAtReset.js';

const now = new Date(2026, 10, 15, 10, 0).getTime();
const threePm = new Date(2026, 10, 15, 15, 0).getTime();
const html = (props: Partial<React.ComponentProps<typeof ContinueAtReset>>) =>
  renderToStaticMarkup(<ContinueAtReset resetAt={null} armedAt={null} now={now} onSchedule={() => {}} {...props} />);

describe('ContinueAtReset', () => {
  it('offers to continue at a known reset', () => {
    const out = html({ resetAt: threePm });
    expect(out).toContain('data-continue-at-reset');
    expect(out).toMatch(/Continue at 3:00\s?PM/);
  });

  it('says when it will continue once scheduled, with a way to call it off', () => {
    const out = html({ resetAt: threePm, armedAt: threePm });
    expect(out).not.toContain('data-continue-at-reset');
    expect(out).toMatch(/Continues by itself at 3:00\s?PM\./);
    expect(out).toContain('Don&#x27;t continue');
  });

  it('shows nothing with no reset known', () => {
    expect(html({})).toBe('');
  });
});
