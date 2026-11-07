import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
vi.mock('./ScreensControl.js', () => ({ ScreensControl: ({ embedded }: { embedded: boolean }) => <div data-embedded={embedded} /> }));
import { WallViewMenu, WallViewOptions } from './WallViewMenu.js';

describe('View options', () => {
  it('uses a quiet toolbar trigger with an illustrated current layout', () => {
    const html = renderToStaticMarkup(<WallViewMenu wall={DEFAULT_WALL_STATE} setWall={() => {}} />);
    expect(html).toContain('class="wall-view-trigger"');
    expect(html).toContain('class="wall-view-icon"');
    expect(html).toContain('View: Multi-agent');
    expect(html).not.toContain('btn-outline');
    expect(html).toContain('aria-haspopup="dialog"');
  });
  it('explains both layouts with decorative previews and native radio inputs', () => {
    const html = renderToStaticMarkup(<WallViewOptions wall={DEFAULT_WALL_STATE} setWall={() => {}} />);
    expect(html).toContain('Workspace view');
    expect(html).toContain('One chat at a time');
    expect(html).toContain('Chats side by side');
    expect(html.match(/class="wall-view-preview"/g)).toHaveLength(2);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('role="switch"');
  });
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
