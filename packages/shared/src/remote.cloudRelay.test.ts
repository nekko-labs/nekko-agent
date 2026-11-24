import { describe, expect, it } from 'vitest';
import { CLOUD_RELAY_URL, isCloudRelay, relayVia } from './remote.js';

// Decision 0116: the same rule as the engine's route::is_cloud_relay.
describe('isCloudRelay', () => {
  it('matches Nekko Cloud Relay whatever the case or trailing slashes', () => {
    expect(isCloudRelay(CLOUD_RELAY_URL)).toBe(true);
    expect(isCloudRelay(' WSS://Nekko-Agent-Relay.fly.dev/// ')).toBe(true);
    expect(relayVia(CLOUD_RELAY_URL)).toBe('cloud');
  });

  it('is every other relay, and nothing for an empty address', () => {
    for (const u of ['ws://gomi.tail1234.ts.net:4400', 'wss://nekko-agent-relay.fly.dev.evil.com', 'wss://relay.example.com']) {
      expect(isCloudRelay(u), u).toBe(false);
      expect(relayVia(u)).toBe('direct');
    }
    expect(isCloudRelay('')).toBe(false);
    expect(isCloudRelay(null)).toBe(false);
  });

  it('stays fast on a long run of slashes', () => {
    const start = performance.now();
    expect(isCloudRelay(`${CLOUD_RELAY_URL}${'/'.repeat(100_000)}x`)).toBe(false);
    expect(isCloudRelay(`${CLOUD_RELAY_URL}${'/'.repeat(100_000)}`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
