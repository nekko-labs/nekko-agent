import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from '../icons.js';
import { IncognitoIcon } from '../icons.js';
import { ChatControls } from './ChatControls.js';

describe('incognito icon', () => {
  it('is the hat-and-sunglasses glyph: a brim, a hat crown and two round lenses with a bridge', () => {
    const svg = renderToStaticMarkup(<IncognitoIcon />);
    expect(svg).toContain('d="M2 11h20"');
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg).toContain('d="M10.5 17a2.1 2.1 0 0 1 3 0"');
  });
  it('replaces the old mask everywhere', () => {
    expect('MaskIcon' in icons).toBe(false);
    const glyph = renderToStaticMarkup(<IncognitoIcon className="h-3.5 w-3.5" />);
    const privacy = renderToStaticMarkup(<ChatControls session={{ id: 's', title: 'Chat', messages: [], createdAt: 0, updatedAt: 0 } as never} isCloudModel={false} onChange={() => {}} only="privacy" />);
    expect(privacy).toContain(glyph);
  });
});

// The title-bar slot observer case moved to views/CommandCenterView.test.ts, where
// the toolbar is rendered.
