import { describe, expect, it } from 'vitest';
import type { ChatMode } from '@nekko-agent/shared';
import { BoltIcon, HandIcon, ShieldCheckIcon } from '../icons.js';
import { ASKS_FIRST, ASKS_MENU_WIDTH } from './AsksFirstMenu.js';

describe('the asks-first selector', () => {
  it('offers exactly the tool policy values, in plain words', () => {
    const values: Record<ChatMode, string> = { ask: 'Asks first', guardrails: 'Asks when it matters', yolo: 'Works on its own' };
    expect(Object.fromEntries(ASKS_FIRST.map((o) => [o.mode, o.label]))).toEqual(values);
  });

  it("shows each choice with the icon Expert's Approvals tiles use for it", () => {
    const icons: Record<ChatMode, unknown> = { ask: HandIcon, guardrails: ShieldCheckIcon, yolo: BoltIcon };
    expect(Object.fromEntries(ASKS_FIRST.map((o) => [o.mode, o.icon]))).toEqual(icons);
  });

  it('opens wide enough for a hint per line, not the old 280px menu', () => {
    expect(ASKS_MENU_WIDTH).toBeGreaterThanOrEqual(400);
  });
});
