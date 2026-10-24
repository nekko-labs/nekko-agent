import { describe, expect, it } from 'vitest';
import { PHONE_CHANNELS, PHONE_MODE_PROOF, phoneChannelClass } from './phone-access.js';
import { STEP_UP_CHALLENGE, STEP_UP_DESKTOP_GUARDED, STEP_UP_PHONE_GUARDED, stepUpMethodKinds, emptySecurityState } from './step-up.js';

describe('step-up policy', () => {
  it('guards the same phone channels as the mode proof', () => {
    expect([...STEP_UP_PHONE_GUARDED.modeRaise.channels]).toEqual([...PHONE_MODE_PROOF.channels]);
  });

  it('lets a phone fetch a challenge as a read, and nothing desktop-guarded', () => {
    expect(phoneChannelClass(STEP_UP_CHALLENGE.channel)).toBe('read');
    expect(STEP_UP_CHALLENGE).toMatchObject({ bytes: 18, ttlMs: 120_000 });
    const phone = new Set<string>(PHONE_CHANNELS);
    for (const [action, list] of Object.entries(STEP_UP_DESKTOP_GUARDED)) {
      if (action === 'modeRaise') continue;
      for (const c of list) expect(phone.has(c), c).toBe(false);
    }
    for (const c of ['security:register', 'security:registerKey', 'security:registerTotp', 'remote:enable', 'remote:setAccess']) {
      expect(phone.has(c), c).toBe(false);
    }
  });

  it('tells a phone only the kinds of method', () => {
    const s = emptySecurityState('r', []);
    s.credentials.push({ id: 'a', publicKey: 'k', counter: 0, name: 'Key', kind: 'security-key', addedAt: 1 });
    s.totp = { secret: 'AAAA', addedAt: 1 };
    expect(stepUpMethodKinds(s)).toEqual(['security-key', 'totp']);
  });
});
