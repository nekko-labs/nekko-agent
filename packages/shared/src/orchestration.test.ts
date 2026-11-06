import { describe, expect, it } from 'vitest';
import { canOfferSubagent, inSubagent } from './orchestration.js';

describe('canOfferSubagent', () => {
  const chat = { messages: [{ role: 'user' }, { role: 'assistant' }] };

  it('offers once the chat has a reply to follow up on', () => {
    expect(canOfferSubagent(chat, 'balanced')).toBe(true);
    expect(canOfferSubagent(chat, undefined)).toBe(true);
    expect(canOfferSubagent({ messages: [{ role: 'user' }] }, 'balanced')).toBe(false);
  });

  it('stays away wherever delegation cannot run', () => {
    expect(canOfferSubagent(chat, 'solo')).toBe(false);
    for (const extra of [{ parentSessionId: 'p' }, { incognito: true }, { offline: true }, { executionMode: 'sandbox' }, { disabledTools: ['spawn_agent'] }]) {
      expect(canOfferSubagent({ ...chat, ...extra }, 'balanced')).toBe(false);
    }
  });
});

it('keeps the message whole and says what was asked', () => {
  expect(inSubagent('Fix the tests')).toBe('Do this in a subagent, then report back:\n\nFix the tests');
});
