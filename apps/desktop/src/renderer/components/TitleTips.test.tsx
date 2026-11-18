import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrInfo } from '@nekko-agent/shared';
import { placeTip } from './HoverTip.js';
import { titleTipAnchor } from './TitleTips.js';
import { PrTip, SessionPrChip } from './SessionPrChip.js';
import { PrLinkChip } from './PrLinkChip.js';

const view = { width: 1000, height: 800 };
const pr = (over: Partial<PrInfo> = {}) => ({
  url: 'https://github.com/o/r/pull/7', owner: 'o', repo: 'r', number: 7, title: 'Rounder tooltips',
  state: 'open', isDraft: false, additions: 12, deletions: 3, changedFiles: 4, checks: 'passing', ...over,
}) as PrInfo;

describe('tip placement', () => {
  it('centres below the anchor and reports the side it took', () => {
    expect(placeTip({ left: 100, top: 100, width: 40, height: 20 }, { width: 80, height: 30 }, 'bottom', view)).toEqual({ left: 80, top: 126, side: 'bottom' });
  });
  it('flips to the other side when the asked one has no room', () => {
    expect(placeTip({ left: 100, top: 770, width: 40, height: 20 }, { width: 80, height: 30 }, 'bottom', view).side).toBe('top');
    expect(placeTip({ left: 100, top: 10, width: 40, height: 20 }, { width: 80, height: 30 }, 'top', view).side).toBe('bottom');
    expect(placeTip({ left: 4, top: 100, width: 20, height: 20 }, { width: 80, height: 30 }, 'left', view).side).toBe('right');
  });
  it('stays inside the window', () => {
    const p = placeTip({ left: 990, top: 100, width: 10, height: 20 }, { width: 200, height: 30 }, 'bottom', view);
    expect(p.left).toBe(1000 - 200 - 8);
  });
});

describe('title tips', () => {
  it('sit beside a small control but follow the pointer over a large element', () => {
    const small = { left: 10, top: 10, width: 28, height: 28 };
    expect(titleTipAnchor(small, { x: 20, y: 20 })).toBe(small);
    expect(titleTipAnchor({ left: 0, top: 0, width: 600, height: 200 }, { x: 300, y: 50 })).toEqual({ left: 300, top: 50, width: 0, height: 18 });
  });
});

describe('PR tips', () => {
  it('drop the native title for our tip on the chat chip and the sidebar chip', () => {
    for (const html of [renderToStaticMarkup(<PrLinkChip href="https://github.com/o/r/pull/7" />), renderToStaticMarkup(<SessionPrChip prs={[pr()]} />)]) {
      expect(html).toContain('data-hover-tip=');
      expect(html).not.toMatch(/<a[^>]* title=/);
    }
  });
  it('show size and checks only while the PR is open', () => {
    const open = renderToStaticMarkup(<PrTip pr={pr()} />);
    expect(open).toContain('Rounder tooltips');
    expect(open).toContain('o/r #7');
    expect(open).toContain('4 files');
    expect(open).toContain('Checks passing');
    const merged = renderToStaticMarkup(<PrTip pr={pr({ state: 'merged' })} />);
    expect(merged).toContain('Merged');
    expect(merged).not.toContain('files');
    expect(merged).not.toContain('Checks');
  });
});
