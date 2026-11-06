import { describe, expect, it, vi } from 'vitest';
import type { ComputerStatus } from '@nekko-agent/shared';
import { computerBlock } from './ComputerChip.js';

vi.mock('../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({}) }) }));

const gomi: ComputerStatus = { id: 'ab12cd34', name: 'gomi', relayUrl: 'ws://100.100.1.1:4400', alts: [], pairedAt: 1, color: 0, state: 'online', route: null, read: true, change: true };

describe('computerBlock', () => {
  it('lets a local chat and a reachable computer through', () => {
    expect(computerBlock(null)).toBeNull();
    expect(computerBlock(gomi)).toBeNull();
  });

  it('says why a message cannot go', () => {
    expect(computerBlock({ ...gomi, change: false })).toBe('gomi allows watching only');
    expect(computerBlock({ ...gomi, state: 'offline' })).toBe('gomi is offline');
    expect(computerBlock({ ...gomi, state: 'update' })).toBe('Update Nekko Agent on gomi');
    expect(computerBlock({ ...gomi, state: 'denied' })).toContain('Connect it again');
  });
});
