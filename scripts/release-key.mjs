#!/usr/bin/env node
// The release signing key (Ed25519): one key that signs what a release says
// about itself (the update feed `latest*.yml` and the Claude policy override).
// The public half is built into the app (crates/nekko-native/src/release_key.rs);
// the private half lives only in the NEKKO_RELEASE_SIGNING_KEY GitHub Actions
// secret and the owner's offline backup. Custody and rotation: docs/signing.md,
// "The release signing key".
//
//   node scripts/release-key.mjs           make a new key pair: prints the Rust
//                                          line to paste into release_key.rs and
//                                          the private key for `gh secret set`
//   node scripts/release-key.mjs public    print the Rust line for the private key
//                                          in $NEKKO_RELEASE_SIGNING_KEY
//
// Nothing is written to disk. The private key is the base64 of the 32-byte
// Ed25519 seed (a PKCS#8 PEM is accepted too).

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SECRET_NAME = 'NEKKO_RELEASE_SIGNING_KEY';
export const KEY_SOURCE = fileURLToPath(new URL('../crates/nekko-native/src/release_key.rs', import.meta.url));

// PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// SPKI wrapping of a raw Ed25519 public key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The private KeyObject from the secret's text: a base64 seed or a PKCS#8 PEM. */
export function privateKeyFromSecret(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error(`${SECRET_NAME} is empty`);
  if (t.startsWith('-----BEGIN')) {
    const key = createPrivateKey(t);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${SECRET_NAME} is not an Ed25519 key`);
    return key;
  }
  const seed = Buffer.from(t, 'base64');
  if (seed.length !== 32 || seed.toString('base64') !== t) {
    throw new Error(`${SECRET_NAME} must be the base64 of a 32-byte Ed25519 seed (or a PKCS#8 PEM)`);
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** The raw 32-byte public key of a private or public KeyObject. */
export function publicKeyBytes(key) {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

/** A raw 32-byte public key as a KeyObject. */
export function publicKeyFromBytes(bytes) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(bytes)]), format: 'der', type: 'spki' });
}

/** The constant's line, as release_key.rs declares it. */
export function rustConstant(bytes) {
  const hex = [...bytes].map((b) => `0x${b.toString(16).padStart(2, '0')}`);
  const rows = [];
  for (let i = 0; i < hex.length; i += 8) rows.push(`    ${hex.slice(i, i + 8).join(', ')},`);
  return `pub const RELEASE_SIGNING_KEY: [u8; 32] = [\n${rows.join('\n')}\n];`;
}

/** The key release_key.rs embeds (32 bytes; all zeros is the placeholder). */
export function embeddedKey(source = readFileSync(KEY_SOURCE, 'utf8')) {
  const m = /pub const RELEASE_SIGNING_KEY: \[u8; 32\] = \[([^\]]*)\];/.exec(source);
  if (!m) throw new Error('RELEASE_SIGNING_KEY not found in release_key.rs');
  const body = m[1].trim();
  const repeat = /^(0x[0-9a-fA-F]+|\d+)\s*;\s*32$/.exec(body);
  if (repeat) return Buffer.alloc(32, Number(repeat[1]));
  const bytes = body.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (bytes.length !== 32 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('RELEASE_SIGNING_KEY in release_key.rs is not 32 bytes');
  }
  return Buffer.from(bytes);
}

export function isPlaceholder(bytes) {
  return bytes.every((b) => b === 0);
}

/** The detached signature as written to `<file>.sig`: base64 and a newline. */
export function signBytes(privateKey, bytes) {
  return `${sign(null, bytes, privateKey).toString('base64')}\n`;
}

export function verifyBytes(publicKey, bytes, sigText) {
  return verify(null, bytes, publicKey, Buffer.from(String(sigText).trim(), 'base64'));
}

/** A fresh pair: the seed for the secret, the public bytes for the constant. */
export function generate() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return { seed: Buffer.from(der.subarray(der.length - 32)).toString('base64'), publicKey: publicKeyBytes(privateKey) };
}

function main(argv, env) {
  if (argv[0] === 'public') {
    const pub = publicKeyBytes(privateKeyFromSecret(env[SECRET_NAME]));
    console.log(rustConstant(pub));
    return 0;
  }
  if (argv.length) {
    console.error('usage: node scripts/release-key.mjs [public]');
    return 2;
  }
  const { seed, publicKey } = generate();
  console.log(`Public key (base64): ${publicKey.toString('base64')}

1. Paste this over the constant in crates/nekko-native/src/release_key.rs:

${rustConstant(publicKey)}

2. Set the private key as the repository secret (it is read from stdin, so it
   stays out of your shell history), then store it in the password manager:

   gh secret set ${SECRET_NAME} --repo nekko-labs/nekko-agent

   Private key (base64 seed, never commit it):
${seed}
`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
