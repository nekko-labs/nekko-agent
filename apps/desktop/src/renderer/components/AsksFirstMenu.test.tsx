import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { YoloIcon } from '../icons.js';
import { describe, expect, it } from 'vitest';
import type { ChatMode } from '@nekko-agent/shared';
import { ASKS_FIRST } from './AsksFirstMenu.js';

describe('the asks-first selector', () => {
  it('offers exactly the tool policy values, in plain words', () => {
    const values: Record<ChatMode, string> = { ask: 'Asks first', guardrails: 'Asks when it matters', yolo: 'Works on its own' };
    expect(Object.fromEntries(ASKS_FIRST.map((o) => [o.mode, o.label]))).toEqual(values);
  });
});

it('uses the hands-up emoji for Works on its own', () => {
  expect(ASKS_FIRST.find(o => o.mode === 'yolo')?.icon).toBe(YoloIcon);
  expect(renderToStaticMarkup(<YoloIcon />)).toContain('🙌');
});
