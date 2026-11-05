import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FollowUpChoices, followUpOptions } from './FollowUpChoices.js';

describe('contextual follow-up choices', () => {
  it('keeps concrete model options, bounded and case-insensitively unique', () => {
    expect(followUpOptions([' Inspect PNGs ', 'inspect pngs', null, 42, '', 'Try\nanother viewer', 'Wait', 'Stop', 'Extra'], 'A different question?'))
      .toEqual(['Inspect PNGs', 'Try another viewer', 'Wait', 'Stop']);
    expect(followUpOptions(['x'.repeat(200)], null)[0]).toHaveLength(120);
  });
  it('falls back to the complete suggested message for an older engine', () => {
    expect(followUpOptions(undefined, 'Can you inspect the saved PNGs?')).toEqual(['Can you inspect the saved PNGs?']);
    expect(followUpOptions([], null)).toEqual([]);
    expect(followUpOptions('not an array', ' ')).toEqual([]);
  });
  it('makes contextual responses primary and execution location a separate control', () => {
    const html = renderToStaticMarkup(<FollowUpChoices options={['Inspect saved PNGs', 'Try another viewer']} canDelegate onSend={() => { throw Error('must not send during render'); }} />);
    expect(html).toContain('Suggested follow-ups');
    expect(html).toContain('Inspect saved PNGs</button>');
    expect(html).toContain('Try another viewer</button>');
    expect(html).toContain('Where to run a suggested follow-up');
    expect(html).not.toContain('Do it here');
    expect(html).not.toContain('Here uses more context');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="radio"');
    expect(html).toContain('checked="" value="here"');
    expect(html).toContain('Subagent</span>');
    expect(html).not.toContain('<select');
  });
  it('offers responses even when delegation is unavailable, without a delegation control', () => {
    const html = renderToStaticMarkup(<FollowUpChoices options={['Inspect saved PNGs']} canDelegate={false} onSend={() => {}} />);
    expect(html).toContain('Inspect saved PNGs</button>');
    expect(html).not.toContain('data-follow-up-location');
    expect(renderToStaticMarkup(<FollowUpChoices options={[]} canDelegate onSend={() => {}} />)).toBe('');
  });
  it('renders suggestions as escaped text, never markup', () => {
    const html = renderToStaticMarkup(<FollowUpChoices options={['<img src=x onerror=alert(1)>']} canDelegate={false} onSend={() => {}} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
