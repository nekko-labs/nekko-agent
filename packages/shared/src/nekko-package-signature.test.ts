import { describe, expect, it } from 'vitest';
import { packageListing, signPackageListing, verifyPackage } from './nekko-package-signature.js';

const enc = (s: string) => new TextEncoder().encode(s);

async function signed() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const files: Record<string, Uint8Array> = { 'nekko.json': enc('{"format":1}'), 'panel.html': enc('<p>hi</p>') };
  files.SIGNATURES = enc(await signPackageListing(await packageListing(files), 'nekko-2026', keys.privateKey));
  return { files, trusted: { 'nekko-2026': keys.publicKey } };
}

describe('package signatures', () => {
  it('lists files sorted by path, without SIGNATURES', async () => {
    const listing = await packageListing({ 'b.txt': enc('b'), 'a.txt': enc('a'), SIGNATURES: enc('x') });
    const lines = listing.trimEnd().split('\n');
    expect(lines[0]).toBe('nekko-signatures 1');
    expect(lines.slice(1).map((l) => l.split('  ')[1])).toEqual(['a.txt', 'b.txt']);
    expect(lines[1]).toMatch(/^[0-9a-f]{64}  a\.txt$/);
  });

  it('verifies a package signed by a trusted key', async () => {
    const { files, trusted } = await signed();
    expect(await verifyPackage(files, trusted)).toEqual({ verified: true, keyId: 'nekko-2026' });
  });

  it('fails on a changed byte, an extra or missing file, an edited listing, an unknown key or no signatures', async () => {
    const { files, trusted } = await signed();
    const cases: Array<Record<string, Uint8Array>> = [
      { ...files, 'panel.html': enc('<p>hI</p>') },
      { ...files, 'extra.js': enc('evil()') },
      Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'panel.html')),
      { ...files, SIGNATURES: enc(new TextDecoder().decode(files.SIGNATURES).replace('panel.html', 'panel.htm')) },
      Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'SIGNATURES')),
    ];
    for (const c of cases) {
      const r = await verifyPackage(c, trusted);
      expect(r.verified).toBe(false);
      expect(r.reason).toBeTruthy();
    }
    expect((await verifyPackage(files, {})).verified).toBe(false);
  });
});
