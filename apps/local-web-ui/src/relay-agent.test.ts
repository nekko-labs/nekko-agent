import { describe, expect, it } from 'vitest';
import { armsMintedCode, idleClock, isIdle, parseCloudScope, scopeSettings } from './relay-agent.js';

/** A Nekko Cloud machine's scope as the relay-agent mode reads it (decision 0017). */
describe('cloud scope', () => {
  it('reads NEKKO_CLOUD_SCOPE with the minimal defaults', () => {
    expect(parseCloudScope(undefined)).toBeNull();
    expect(parseCloudScope('not json')).toBeNull();
    expect(parseCloudScope('[1]')).toBeNull();
    expect(parseCloudScope('{}')).toEqual({ repos: [], privacyShield: true, memory: false, syncBack: true });
    expect(parseCloudScope('{"repos":["o/r",3],"privacyShield":false,"memory":true}')).toEqual({ repos: ['o/r'], privacyShield: false, memory: true, syncBack: true });
  });

  it('pins Privacy Shield on unless the scope turns it off', () => {
    expect(scopeSettings({ privacyShield: true })).toEqual({ privacyMode: 'shield' });
    expect(scopeSettings({})).toEqual({ privacyMode: 'shield' });
    expect(scopeSettings({ privacyShield: false })).toEqual({});
  });
});

describe('a machine\'s minted pairing code', () => {
  it('pairs only a machine that has never paired', () => {
    expect(armsMintedCode([])).toBe(true);
    expect(armsMintedCode([{ id: 'phone-1', revoked: true }])).toBe(false);
  });
});

describe('a Nekko Cloud machine stopping itself when idle', () => {
  it('is idle only with no device connected and no chat running', () => {
    expect(isIdle({ connected: [] }, [])).toBe(true);
    expect(isIdle(null, null)).toBe(true);
    expect(isIdle({ connected: ['phone-1'] }, [])).toBe(false);
    expect(isIdle({ connected: [] }, ['s1'])).toBe(false);
  });

  it('stops after the limit of unbroken idle, and any activity restarts the clock', () => {
    const over = idleClock(15, 0);
    expect(over(true, 10)).toBe(false);
    expect(over(false, 12)).toBe(false);
    expect(over(true, 26)).toBe(false);
    expect(over(true, 27)).toBe(true);
  });
});
