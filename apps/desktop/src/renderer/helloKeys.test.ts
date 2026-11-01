import { describe, expect, it } from 'vitest';
import { helloProof, helloText } from '@nekko-agent/shared';
import { loadHelloKeys } from './helloKeys.js';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('the browser device key', () => {
  it('is made once and kept, and signs HELLOs that verify', async () => {
    const store = memory();
    const a = await loadHelloKeys(store);
    const b = await loadHelloKeys(store);
    const raw = async (k: CryptoKeyPair) => new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
    expect(await raw(b)).toEqual(await raw(a));
    const proof = await helloProof(b, 'dev-1', 'room-1', 'nonce');
    const sig = Uint8Array.from(atob(proof.sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      a.publicKey,
      sig,
      new TextEncoder().encode(helloText('dev-1', 'room-1', 'nonce')),
    );
    expect(ok).toBe(true);
  });

  it('makes a new key when the saved one is unreadable', async () => {
    const store = memory();
    store.setItem('nekko_hello_key', 'not json');
    const keys = await loadHelloKeys(store);
    expect(keys.privateKey.type).toBe('private');
    expect(JSON.parse(store.m.get('nekko_hello_key')!).publicKey.crv).toBe('P-256');
  });
});
