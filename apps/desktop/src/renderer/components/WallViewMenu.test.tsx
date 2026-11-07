import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
vi.mock('./ScreensControl.js', () => ({ ScreensControl: ({ embedded }: { embedded: boolean }) => <div data-embedded={embedded} /> }));
import { WallViewOptions } from './WallViewMenu.js';

describe('View options', () => {
  it.each(['focus', 'grid', 'fixed'] as const)('keeps layout and snap semantics in %s', mode => {
    const wall = { ...DEFAULT_WALL_STATE, snap: true, layout: { ...DEFAULT_WALL_STATE.layout, mode: mode === 'fixed' ? 'grid' as const : mode, fixedGrid: mode === 'fixed' } };
    const html = renderToStaticMarkup(<WallViewOptions wall={wall} setWall={() => {}} />);
    expect(html).toContain('Single agent');
    expect(html).toContain('Multi-agent');
    expect(html).toContain('Shift+1');
    expect(html).toContain('Shift+2');
    expect(html).toContain('data-embedded="true"');
    const snap = html.match(/<input[^>]*data-view-snap[^>]*>/)![0];
    expect(snap).toContain('checked=""');
    expect(snap.includes('disabled=""')).toBe(mode !== 'grid');
    expect(html).not.toContain('Focused');
    expect(html).not.toContain('Dynamic');
  });
});
