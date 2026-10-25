import { describe, expect, it } from 'vitest';
import { parseCloudScope, scopeSettings } from './relay-agent.js';

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
