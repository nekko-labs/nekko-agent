#!/usr/bin/env node
// Publish the model list for apps already installed: wrap the list this
// release ships (crates/nekko-machine/src/model-feed.json) in a signed
// document and write it to the release folder as `model-feed.json`, to be
// uploaded beside the update feed. A daemon from an older release fetches it
// on its next update check, verifies it against the key built into the app
// and recommends from it when it is newer than its own
// (crates/nekkod/src/model_feed.rs).
//
//   node scripts/sign-model-feed.mjs <release-dir>
//
// Prints the written path, or nothing when nothing was written. The key rules
// are the update feed's (scripts/sign-update-feed.mjs): while the built-in key
// is the all-zero placeholder a missing secret is a warning and nothing is
// written (no app would accept it); once a real key is built in, a missing or
// mismatched secret fails the step.

import { readFileSync, writeFileSync } from 'node:fs';
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

export const LIST_SOURCE = fileURLToPath(new URL('../crates/nekko-machine/src/model-feed.json', import.meta.url));
/** The asset's name beside the update feed (`FEED_FILE` in model_feed.rs). */
export const ASSET = 'model-feed.json';
const DOC_TYPE = 'nekko.modelFeed';

/**
 * A list's version is `YYYY-MM-DD.N`. The serial a daemon refuses to go back
 * from follows it: the date's digits, then the day's count in three digits.
 */
export function feedSerial(version) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(\d{1,3})$/.exec(String(version));
  if (!m) throw new Error(`Model list version "${version}" is not YYYY-MM-DD.N with N under 1000.`);
  return Number(`${m[1]}${m[2]}${m[3]}`) * 1000 + Number(m[4]);
}

/** The document a daemon verifies: the list, its serial, and the day it was made. */
export function feedDocument(feed) {
  return {
    type: DOC_TYPE,
    version: 1,
    serial: feedSerial(feed.version),
    issuedAt: `${String(feed.version).slice(0, 10)}T00:00:00Z`,
    feed,
  };
}

/**
 * @param {string} dir the release folder
 * @param {{ secret?: string, embedded?: Buffer, rotating?: boolean, feed?: object, log?: (s: string) => void, warn?: (s: string) => void }} opts
 * @returns {{ code: number, written: string[] }}
 */
export function signModelFeed(
  dir,
  {
    secret,
    embedded = embeddedKey(),
    rotating = false,
    feed = JSON.parse(readFileSync(LIST_SOURCE, 'utf8')),
    log = console.log,
    warn = console.error,
  } = {},
) {
  const placeholder = isPlaceholder(embedded);
  const fail = (msg) => {
    warn(`::error::${msg}`);
    return { code: 1, written: [] };
  };
  if (!secret || !String(secret).trim()) {
    if (placeholder) {
      warn(
        `::warning::${SECRET_NAME} is not set and the app has no release key yet (placeholder), so no model list is published: no app would accept it. See docs/signing.md, "The release signing key".`,
      );
      return { code: 0, written: [] };
    }
    return fail(`${SECRET_NAME} is not set, so the model list cannot be signed (docs/signing.md, "The release signing key").`);
  }
  let key;
  try {
    key = privateKeyFromSecret(secret);
  } catch (e) {
    return fail(e.message);
  }
  const pub = publicKeyBytes(key);
  if (placeholder) {
    warn(`::warning::Signing the model list, but the app has no release key built in yet, so every app refuses it.`);
  } else if (!pub.equals(embedded) && rotating) {
    warn(`::warning::Key rotation bridge release: signing the model list with a key other than the one this build embeds.`);
  } else if (!pub.equals(embedded)) {
    return fail(
      `${SECRET_NAME} does not match the key built into the app (crates/nekko-native/src/release_key.rs): the app would refuse this model list.`,
    );
  }
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(feedDocument(feed)));
  } catch (e) {
    return fail(e.message);
  }
  const signature = signBytes(key, payload).trim();
  if (!verifyBytes(key, payload, signature)) return fail('The signature over the model list does not verify.');
  const path = join(dir, ASSET);
  writeFileSync(path, `${JSON.stringify({ payload: payload.toString('base64'), signature })}\n`);
  log(path);
  return { code: 0, written: [path] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/sign-model-feed.mjs <release-dir>');
    process.exit(2);
  }
  const { code } = signModelFeed(dir, {
    secret: process.env[SECRET_NAME],
    rotating: process.env.NEKKO_RELEASE_KEY_ROTATION === '1',
  });
  process.exit(code);
}
