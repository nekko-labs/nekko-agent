import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ephemeralKeys, open, publicKeyText, sessionKey } from './e2e.js';
import { REMOTE_PROTOCOL_VERSION, challengeIsGenuine, helloProof, helloText, hostText, sessionInfo } from './remote.js';

// The shared handshake fixture, also read by the computer and both phones.
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../crates/nekko-remote/tests/golden/relay-handshake.json'), 'utf8'),
);

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('device-key HELLO', () => {
  it('signs the same text as the computer and the phones', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(fixture.protocol);
    const c = fixture.challenge.frame;
    expect(helloText(fixture.device.deviceId, fixture.room, c.challenge, c.eph, fixture.clientEph.publicKey)).toBe(fixture.helloKey.text);
    expect(hostText(fixture.room, c.challenge, c.eph)).toBe(fixture.hostText);
    expect(sessionInfo(fixture.room, c.challenge, c.eph, fixture.clientEph.publicKey)).toBe(fixture.sessionInfo);
  });

  it('checks a challenge against the pinned host key', async () => {
    const c = fixture.challenge.frame;
    expect(await challengeIsGenuine(fixture.hostKey.publicKey, fixture.room, c)).toBe(true);
    expect(await challengeIsGenuine(fixture.hostKey.publicKey, 'another-room', c)).toBe(false);
    expect(await challengeIsGenuine(fixture.helloKey.publicKey, fixture.room, c)).toBe(false);
    expect(await challengeIsGenuine('not a key', fixture.room, c)).toBe(false);
  });

  it('derives the session key the computer did and opens the HELLO', async () => {
    const pkcs8 = (hex: string, pub: string) => {
      // The fixture's scalar as JWK, which WebCrypto takes for P-256.
      const raw = fromB64(pub);
      const url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const d = Uint8Array.from(hex.match(/../g)!.map((b: string) => parseInt(b, 16)));
      return { kty: 'EC', crv: 'P-256', d: url(d), x: url(raw.slice(1, 33)), y: url(raw.slice(33)), ext: true };
    };
    const ours = await crypto.subtle.importKey('jwk', pkcs8(fixture.clientEph.privateKeyHex, fixture.clientEph.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const key = await sessionKey(ours, fixture.hostEph.publicKey, fixture.sessionInfo);
    expect(await open(key, fixture.helloFrame.enc)).toEqual(fixture.hello);
    const fresh = await ephemeralKeys();
    expect(fromB64(await publicKeyText(fresh.publicKey))).toHaveLength(65);
  });

  it('verifies the fixture signature with the fixture key', async () => {
    const key = await crypto.subtle.importKey('raw', fromB64(fixture.helloKey.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const text = new TextEncoder().encode(fixture.helloKey.text);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(fixture.helloKey.sig), text);
    expect(ok).toBe(true);
  });

  it('produces an X9.63 key and a raw signature that verify', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const proof = await helloProof(keys, 'phone-1', 'room-1', 'challenge-1', 'host-half', 'client-half');
    expect(fromB64(proof.helloKey)).toHaveLength(65);
    expect(fromB64(proof.helloKey)[0]).toBe(4);
    expect(fromB64(proof.sig)).toHaveLength(64);
    const text = new TextEncoder().encode(helloText('phone-1', 'room-1', 'challenge-1', 'host-half', 'client-half'));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, fromB64(proof.sig), text)).toBe(true);
  });
});
