import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GfIcon } from './gentleface-icons.js';
import { GENTLEFACE_MOTION } from './gentleface-motion-assets.js';
import { FolderIcon, GaugeIcon, InfoIcon, LockIcon, SendIcon, ServerIcon, TerminalIcon } from './icons.js';

describe('Gentleface controls', () => {
  it('wires shared app exports to actual animated SVGs, not just static weight swaps', () => {
    for (const Icon of [FolderIcon, GaugeIcon, InfoIcon, LockIcon, SendIcon, ServerIcon, TerminalIcon]) {
      const html = renderToStaticMarkup(<Icon className="h-4 w-4" />);
      expect(html).toContain('gf-icon-motion');
      expect(html).toContain('<animate');
      expect(html).not.toContain('gf-icon-solid');
    }
  });

  it('preserves sizing, inherited color and optional accessible titles', () => {
    const html = renderToStaticMarkup(<GfIcon name="send" title="Send message" className="h-4 w-4" />);
    expect(html).toContain('gf-icon h-4 w-4');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('role="img"');
    expect(html).toContain('Send message');
    expect(renderToStaticMarkup(<GfIcon name="send" />)).toContain('aria-hidden="true"');
  });

  it('keeps the static fallback for icons upstream does not animate', () => {
    const html = renderToStaticMarkup(<GfIcon name="shield-question" />);
    expect(html).toContain('gf-icon-line');
    expect(html).toContain('gf-icon-solid');
    expect(html).not.toContain('<animate');
  });

  it('embeds only self-contained trusted SVG motion with valid one-shot intervals', () => {
    expect(Object.keys(GENTLEFACE_MOTION)).toHaveLength(14);
    for (const { svg, frames } of Object.values(GENTLEFACE_MOTION)) {
      expect(svg).toMatch(/^<svg\s/);
      expect(svg).not.toMatch(/<script|<foreignObject|\bon\w+=|(?:href|src)="(?:https?:|data:|javascript:)/i);
      expect(frames[0]).toBeGreaterThanOrEqual(0);
      expect(frames[1]).toBeGreaterThan(frames[0]);
    }
  });
});
