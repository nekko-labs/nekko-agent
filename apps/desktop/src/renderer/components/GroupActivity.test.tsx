import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GroupActivity } from './GroupActivity.js';

describe('GroupActivity', () => {
  it.each([['building', 8], ['verifying', 6], ['watching', 8]] as const)('draws %s as one strip of %i frames', (kind, frames) => {
    const html = renderToStaticMarkup(<GroupActivity kind={kind} />);
    expect(html).toContain(`data-group-activity="${kind}"`);
    expect(html).toContain(`--group-activity-frames:${frames}`);
    expect(html).toContain(`width="${frames * 24}"`);
    expect(html.match(/data-part="pixel-head"/g)).toHaveLength(frames);
  });

  it('holds one frame when turned off in Settings', () => {
    expect(renderToStaticMarkup(<GroupActivity kind="building" />)).toContain('class="group-activity"');
    expect(renderToStaticMarkup(<GroupActivity kind="building" animated={false} />)).toContain('class="group-activity group-activity-still"');
  });

  it('answers to the setting alone, not the system reduced-motion preference', () => {
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    // The app-wide reduced-motion rule forces every animation to one 0.01ms run; only !important here outranks it.
    expect(css).toContain('animation-duration: 0.01ms !important');
    expect(css).toContain('.group-activity svg { animation-duration: var(--group-activity-duration) !important; animation-iteration-count: infinite !important; }');
    expect(css).not.toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.group-activity/);
  });

  it('is decoration: the heading already says the group and its count', () => {
    expect(renderToStaticMarkup(<GroupActivity kind="building" />)).toContain('aria-hidden="true"');
  });
});
