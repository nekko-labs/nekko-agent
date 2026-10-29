import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackgroundChip } from './BackgroundChip.js';

describe('background chip', () => {
  it('is absent while nothing runs in the background', () => {
    expect(renderToStaticMarkup(<BackgroundChip state={{ running: 0, paused: 0, reason: null }} />)).toBe('');
  });

  it('shows a paused automation and why, whole in the dock and short in the resource chip', () => {
    const state = { running: 1, paused: 1, reason: 'active' as const };
    const dock = renderToStaticMarkup(<BackgroundChip state={state} />);
    expect(dock).toContain('data-background-chip="paused"');
    expect(dock).toContain('Background: 1 paused · you’re using the computer');
    const hud = renderToStaticMarkup(<BackgroundChip state={state} compact />);
    expect(hud).toContain('>BG</span>paused');
    expect(hud).toContain('title="Background: 1 paused · you’re using the computer. It carries on from where it stopped once this computer is free."');
  });

  it('shows one running', () => {
    expect(renderToStaticMarkup(<BackgroundChip state={{ running: 1, paused: 0, reason: null }} />)).toContain('data-background-chip="running"');
  });
});
