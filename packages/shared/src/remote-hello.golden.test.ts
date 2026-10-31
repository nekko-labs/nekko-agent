import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMOTE_PROTOCOL_VERSION, helloProof, helloText } from './remote.js';

// The shared handshake fixture, also read by the computer and both phones.
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../crates/nekko-remote/tests/golden/relay-handshake.json'), 'utf8'),
);

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('device-key HELLO', () => {
  it('signs the same text as the computer and the phones', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(fixture.protocol);
    expect(helloText(fixture.device.deviceId, fixture.room, fixture.challenge.frame.challenge)).toBe(fixture.helloKey.text);
  });

  it('verifies the fixture signature with the fixture key', async () => {
    const key = await crypto.subtle.importKey('raw', fromB64(fixture.helloKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const text = new TextEncoder().encode(fixture.helloKey.text);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(fixture.helloKey.sig), text);
    expect(ok).toBe(true);
  });

  it('produces an X9.63 key and a raw signature that verify', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const proof = await helloProof(keys, 'phone-1', 'room-1', 'challenge-1');
    expect(fromB64(proof.helloKey)).toHaveLength(65);
    expect(fromB64(proof.helloKey)[0]).toBe(4);
    expect(fromB64(proof.sig)).toHaveLength(64);
    const text = new TextEncoder().encode(helloText('phone-1', 'room-1', 'challenge-1'));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, fromB64(proof.sig), text)).toBe(true);
  });
});
