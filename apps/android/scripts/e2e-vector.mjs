// Cross-language E2E check for the Android client.
//
//   node apps/android/scripts/e2e-vector.mjs            → print a fixed WebCrypto test vector
//   node apps/android/scripts/e2e-vector.mjs open FILE  → open frames the Kotlin side sealed
//
// The "open" mode reads JSON {secret, room, frames:[{sealed, plaintext}]} written by
// `NEKKO_E2E_OUT=FILE ./gradlew :protocol:test`, and decrypts each frame with the
// real agent implementation (packages/shared/src/e2e.ts, via the built dist when
// present, otherwise an equivalent WebCrypto construction).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sharedE2E() {
  const dist = resolve(root, 'packages/shared/dist/e2e.js');
  if (existsSync(dist)) return { ...(await import(pathToFileURL(dist).href)), source: 'packages/shared/dist/e2e.js' };
  // Same construction as packages/shared/src/e2e.ts (kept in sync by the TS unit tests).
  return {
    source: 'inline WebCrypto copy (build packages/shared to use the real module)',
    async deriveKey(secret, salt) {
      const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(`nekko-relay:${salt}`), iterations: 100_000, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    },
    async open(key, blob) {
      const packed = Buffer.from(blob, 'base64');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.subarray(0, 12) }, key, packed.subarray(12));
      return JSON.parse(new TextDecoder().decode(pt));
    },
  };
}

if (process.argv[2] === 'open') {
  const input = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const e2e = await sharedE2E();
  const key = await e2e.deriveKey(input.secret, input.room);
  let ok = 0;
  for (const f of input.frames) {
    const value = await e2e.open(key, f.sealed);
    if (JSON.stringify(value) !== JSON.stringify(JSON.parse(f.plaintext))) {
      console.error('MISMATCH', f.plaintext, JSON.stringify(value));
      process.exit(1);
    }
    ok++;
  }
  console.log(`opened ${ok} Kotlin-sealed frame(s) with ${e2e.source}`);
} else {
  const secret = '00112233445566778899aabbccddeeff';
  const room = 'a1b2c3d4e5f60718';
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(`nekko-relay:${room}`), iterations: 100_000, hash: 'SHA-256' }, base, 256));
  const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).map((_, i) => i + 1);
  const plaintext = JSON.stringify({ type: 'req', id: 7, channel: 'app:info', args: ['héllo ✓ 🐱'] });
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  const packed = new Uint8Array(12 + ct.length);
  packed.set(iv);
  packed.set(ct, 12);
  console.log(JSON.stringify({ secret, room, keyHex: hex(bits), ivHex: hex(iv), plaintext, sealed: Buffer.from(packed).toString('base64') }, null, 2));
}
