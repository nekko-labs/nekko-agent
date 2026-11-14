import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toggle } from './Toggle.js';

describe('the one switch', () => {
  it('is a quiet-switch with the switch role and its state', () => {
    const html = renderToStaticMarkup(<Toggle value onChange={() => {}} label="Pause all automations" describedBy="hint" />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-describedby="hint"');
    expect(html).toContain('class="quiet-switch"');
  });

  it('draws no thumb of its own and no inline colour, so every switch matches', () => {
    const html = renderToStaticMarkup(<Toggle value={false} onChange={() => {}} />);
    expect(html).not.toContain('<span');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('bg-white');
  });
});
