import { describe, expect, it } from 'vitest';
import { PHONE_ALWAYS_DENIED, PHONE_CHANNELS, phoneChannelAllowed } from './phone-access.js';

describe('the phone views beyond the chat', () => {
  it('keep files, terminal commands, the browser, stack calls and automation editing off the phone', () => {
    // Git opened with IO-33 FA-2 (phone-git.test.ts); the stack calls did not.
    for (const channel of [
      'pr:continueStack', 'pr:linkStack', 'file:read', 'file:write', 'dir:list',
      'terminal:run', 'shell:openPath', 'task:create', 'task:update', 'task:delete', 'workflow:create',
      'workflow:update', 'workflow:delete', 'workflow:cancel', 'workflow:event', 'changes:accept',
    ]) {
      expect(phoneChannelAllowed(channel), channel).toBe(false);
    }
    for (const c of PHONE_CHANNELS) expect((PHONE_ALWAYS_DENIED.channels as string[]).includes(c), c).toBe(false);
  });
});
