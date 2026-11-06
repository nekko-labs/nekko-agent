import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('animates both compound glyphs without replacing their licensed artwork', () => {
    for (const name of ['shield-question', 'brain-circuit'] as const) {
      const html = renderToStaticMarkup(<GfIcon name={name} />);
      expect(html).toContain('gf-icon-motion');
      expect(html).toContain('<animateTransform');
      expect(html).toContain('fill="currentColor" stroke="none"');
      expect(html).not.toContain('gf-icon-solid');
    }
  });

  it('keeps the previously unused helpers wired to real semantic controls', () => {
    const controls = {
      'components/ModePanel.tsx': ['BrainCircuitIcon', 'ShieldQuestionIcon'],
      'components/PaneFrame.tsx': ['CheckCircleIcon'],
      'components/cloud/SyncSettings.tsx': ['LogOutIcon'],
      'components/RemoteAccess.tsx': ['RouterIcon', 'LogOutIcon'],
      'views/WorkflowsView.tsx': ['WorkflowIcon'],
    };
    for (const [file, icons] of Object.entries(controls)) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const icon of icons) expect(source, file).toContain('<' + icon);
    }
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
