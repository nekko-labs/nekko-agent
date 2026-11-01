import { describe, expect, it } from 'vitest';
import { deriveKey, open, relayAuth, seal } from './e2e.js';

// The shared vector (crates/nekko-remote/tests/golden/crypto.json, the phones' e2e-vector.json).
const SECRET = '00112233445566778899aabbccddeeff';
const ROOM = 'a1b2c3d4e5f60718';
const RELAY_AUTH = '7a8260aa4bed6b4bf417c3884bd3e3b7b3c4d4ad2003f1426f91c6f7707de35c';

describe('relay credential', () => {
  it('matches the shared vector and is neither the secret nor room-independent', async () => {
    const auth = await relayAuth(SECRET, ROOM);
    expect(auth).toBe(RELAY_AUTH);
    expect(auth).not.toContain(SECRET);
    expect(await relayAuth(SECRET, 'another-room')).not.toBe(auth);
  });

  it('cannot stand in for the secret when deriving the E2E key', async () => {
    const real = await deriveKey(SECRET, ROOM);
    const fromAuth = await deriveKey(RELAY_AUTH, ROOM);
    const sealed = await seal(real, { type: 'hello', deviceId: 'phone-1' });
    expect(await open(real, sealed)).toEqual({ type: 'hello', deviceId: 'phone-1' });
    await expect(open(fromAuth, sealed)).rejects.toThrow();
  });
});
