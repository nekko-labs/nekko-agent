import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMode, Session } from '@nekko-agent/shared';
import { CHAT_MODE_ICON } from '../gentleface-icons.js';
import { ASKS_FIRST, ASKS_MENU_WIDTH, privacyToggles } from './AsksFirstMenu.js';

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

  it('ends with Incognito, Privacy Shield and Internet access switches, in that order', () => {
    const session = { id: 's', incognito: true, offline: false } as unknown as Session;
    const row = privacyToggles(session, { shieldOn: false, isCloudModel: false });
    expect(row.map((t) => [t.key, t.on, t.disabled])).toEqual([
      ['incognito', true, false],
      ['shield', false, false],
      ['internet', true, false],
    ]);
  });

  it('keeps the internet on for a cloud model, but lets an offline chat come back online', () => {
    const online = privacyToggles({ id: 's', offline: false } as unknown as Session, { shieldOn: true, isCloudModel: true });
    expect(online.find((t) => t.key === 'internet')).toMatchObject({ on: true, disabled: true });
    expect(online.find((t) => t.key === 'shield')).toMatchObject({ on: true });
    const offline = privacyToggles({ id: 's', offline: true } as unknown as Session, { shieldOn: false, isCloudModel: true });
    expect(offline.find((t) => t.key === 'internet')).toMatchObject({ on: false, disabled: false });
  });
});
