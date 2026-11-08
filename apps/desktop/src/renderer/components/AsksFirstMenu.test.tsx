import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMode } from '@nekko-agent/shared';
import { CHAT_MODE_ICON } from '../gentleface-icons.js';
import { ASKS_FIRST, ASKS_MENU_WIDTH } from './AsksFirstMenu.js';

describe('the approvals selector', () => {
  it('offers exactly the tool policy values, in plain words', () => {
    const values: Record<ChatMode, string> = { ask: 'Always ask', guardrails: 'Ask when it matters', yolo: 'No restrictions' };
    expect(Object.fromEntries(ASKS_FIRST.map((o) => [o.mode, o.label]))).toEqual(values);
  });

  it('draws each choice with its Gentleface icon, the same ones the Mode panel uses', () => {
    const icons: Record<ChatMode, string> = { ask: 'hand', guardrails: 'shield-check', yolo: 'running' };
    for (const o of ASKS_FIRST) {
      expect(o.icon).toBe(CHAT_MODE_ICON[o.mode]);
      expect(renderToStaticMarkup(<o.icon />)).toContain(`data-gf-icon="${icons[o.mode]}"`);
    }
  });

  it('opens wide enough for a hint per line, not the old 280px menu', () => {
    expect(ASKS_MENU_WIDTH).toBeGreaterThanOrEqual(400);
  });
});
