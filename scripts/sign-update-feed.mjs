#!/usr/bin/env node
// Sign the update feed: every `latest*.yml` electron-builder wrote into the
// release folder gets a detached Ed25519 signature beside it, `<file>.sig`
// (base64 of the signature over the file's exact bytes), with the release
// signing key from $NEKKO_RELEASE_SIGNING_KEY. The updater checks it against
// the key built into the app (crates/nekko-native/src/release_key.rs) before
// trusting the feed. docs/signing.md, "The release signing key".
//
//   node scripts/sign-update-feed.mjs <release-dir>
//
// Prints the written `.sig` paths, one per line. While the built-in key is the
// all-zero placeholder, a missing secret is a warning (the app checks nothing
// yet); once a real key is built in, a missing secret, a secret that does not
// match the built-in key, or a release with no feed file fails the step.
// NEKKO_RELEASE_KEY_ROTATION=1 lets the secret differ from the built-in key,
// for the one bridge release of a key rotation.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECRET_NAME,
  embeddedKey,
  isPlaceholder,
  privateKeyFromSecret,
  publicKeyBytes,
  signBytes,
  verifyBytes,
} from './release-key.mjs';

export const FEED_FILE = /^latest(-[a-z0-9-]+)?\.yml$/;

/**
 * @param {string} dir the release folder
 * @param {{ secret?: string, embedded?: Buffer, rotating?: boolean, log?: (s: string) => void, warn?: (s: string) => void }} opts
 *   `rotating`: the bridge release of a key rotation, signed with the old key
 *   while it builds in the new one (docs/signing.md, "Rotating it").
 * @returns {{ code: number, written: string[] }}
 */
export function signFeeds(
  dir,
  { secret, embedded = embeddedKey(), rotating = false, log = console.log, warn = console.error } = {},
) {
  const placeholder = isPlaceholder(embedded);
  const feeds = readdirSync(dir).filter((f) => FEED_FILE.test(f)).sort();
  const fail = (msg) => {
    warn(`::error::${msg}`);
    return { code: 1, written: [] };
  };
  if (!secret || !String(secret).trim()) {
    if (placeholder) {
      warn(
        `::warning::${SECRET_NAME} is not set and the app has no release key yet (placeholder), so the update feed is published unsigned. See docs/signing.md, "The release signing key".`,
      );
      return { code: 0, written: [] };
    }
    return fail(
      `${SECRET_NAME} is not set, but the app has a release key built in: it would refuse this release's unsigned update feed. Set the secret (docs/signing.md, "The release signing key").`,
    );
  }
  let key;
  try {
    key = privateKeyFromSecret(secret);
  } catch (e) {
    return fail(e.message);
  }
  const pub = publicKeyBytes(key);
  if (placeholder) {
    warn(`::warning::Signing the update feed, but the app has no release key built in yet, so it does not check the signature.`);
  } else if (!pub.equals(embedded) && rotating) {
    warn(`::warning::Key rotation bridge release: signing with a key other than the one this build embeds.`);
  } else if (!pub.equals(embedded)) {
    return fail(
      `${SECRET_NAME} does not match the key built into the app (crates/nekko-native/src/release_key.rs): the app would refuse this feed.`,
    );
  }
  if (!feeds.length) return fail(`No latest*.yml update feed in ${dir} to sign.`);
  const written = [];
  for (const name of feeds) {
    const path = join(dir, name);
    const bytes = readFileSync(path);
    const sig = signBytes(key, bytes);
    if (!verifyBytes(key, bytes, sig)) return fail(`The signature over ${name} does not verify.`);
    writeFileSync(`${path}.sig`, sig);
    written.push(`${path}.sig`);
    log(`${path}.sig`);
  }
  return { code: 0, written };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/sign-update-feed.mjs <release-dir>');
    process.exitCode = 2;
  } else {
    process.exitCode = signFeeds(dir, {
      secret: process.env[SECRET_NAME],
      rotating: process.env.NEKKO_RELEASE_KEY_ROTATION === '1',
    }).code;
  }
}
