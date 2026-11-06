/*
 * SIGNATURES in a .nekko package (decision 0032): a sorted SHA-256 listing of
 * every other file, then one ECDSA P-256 signature per key over that listing.
 *
 *   nekko-signatures 1
 *   <sha256 hex>  <path>
 *   --
 *   sig <key id> <base64 signature>
 *
 * "Verified by Nekko" means a pinned Nekko Labs key signed these exact bytes.
 */

import { PACKAGE_SIGNATURES } from './nekko-package.js';

const HEADER = 'nekko-signatures 1\n';
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytes = (s: string) => new TextEncoder().encode(s);

/** The listing every signature covers: each file but SIGNATURES, sorted by path. */
export async function packageListing(files: Record<string, Uint8Array>): Promise<string> {
  const paths = Object.keys(files).filter((p) => p !== PACKAGE_SIGNATURES).sort();
  const lines = await Promise.all(paths.map(async (p) => `${hex(await crypto.subtle.digest('SHA-256', files[p] as BufferSource))}  ${p}\n`));
  return HEADER + lines.join('');
}

/** The full SIGNATURES text for a listing, signed by one key. Used by the offline signing script and tests. */
export async function signPackageListing(listing: string, keyId: string, key: CryptoKey): Promise<string> {
  return `${listing}--\nsig ${keyId} ${b64(await crypto.subtle.sign(SIGN, key, bytes(listing)))}\n`;
}

export interface PackageVerification { verified: boolean; keyId?: string; reason?: string }

/** Whether a trusted key signed exactly these files. Never throws. */
export async function verifyPackage(files: Record<string, Uint8Array>, trusted: Record<string, CryptoKey>): Promise<PackageVerification> {
  const sigFile = files[PACKAGE_SIGNATURES];
  if (!sigFile) return { verified: false, reason: 'no SIGNATURES file' };
  const text = new TextDecoder().decode(sigFile);
  const cut = text.indexOf('\n--\n');
  if (cut < 0) return { verified: false, reason: 'SIGNATURES has no signature section' };
  const listing = text.slice(0, cut + 1);
  if (listing !== (await packageListing(files))) return { verified: false, reason: 'the files do not match the signed listing' };
  for (const line of text.slice(cut + 4).split('\n')) {
    const [tag, keyId, sig] = line.split(' ');
    const key = tag === 'sig' && keyId && Object.hasOwn(trusted, keyId) ? trusted[keyId] : undefined;
    if (!key || !sig) continue;
    try {
      if (await crypto.subtle.verify(SIGN, key, unb64(sig), bytes(listing))) return { verified: true, keyId };
    } catch { /* malformed signature: try the next line */ }
  }
  return { verified: false, reason: 'no signature from a trusted key' };
}
