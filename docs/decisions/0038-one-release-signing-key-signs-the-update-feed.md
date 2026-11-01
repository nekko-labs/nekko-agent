---
status: accepted
date: 2026-11-01
---

# 0038. One release signing key signs the update feed and the Claude policy override

## Context

The updater (`crates/nekko-native/src/update.rs`, run by nekkod) reads
electron-builder's `latest.yml`, `latest-mac.yml` and `latest-linux.yml` from
the latest GitHub release and trusts the SHA-512 in them. On Windows and macOS
the installer's publisher is checked against the running app (#1447), but
Linux has no publisher check, and a substituted feed could still point an
install at any file whose checksum it states. The security audit (#1413)
asked for the feed itself to be signed (#1479).

The signed Claude policy override (`claude-policy.json`,
[spec](../../spec/product/claude-policy.md)) already verified an Ed25519
signature against a "release policy key", but no such key existed: the
constant was an all-zero placeholder that refuses every override.

## Decision

1. **One key.** A single Ed25519 release signing key. Its public half is one
   constant, `RELEASE_SIGNING_KEY` in `crates/nekko-native/src/release_key.rs`,
   read by both the feed check and the Claude policy check. Its private half is
   the `NEKKO_RELEASE_SIGNING_KEY` repository secret and one offline copy.
2. **A detached signature beside each feed file.** The release workflow signs
   every `latest*.yml` electron-builder produced, over its exact bytes, and
   uploads `<file>.sig` (base64 of the 64-byte signature) to the same release
   (`scripts/sign-update-feed.mjs`, `node:crypto`, no new dependencies). The
   feed format itself is untouched, so electron-builder and older apps are
   unaffected.
3. **The updater checks before it parses.** With a real key built in, nekkod
   fetches `<feed>.sig`, verifies the feed's bytes, and only then parses them.
   A missing or bad signature is an update error the version pill already
   shows; nothing is downloaded.
4. **The placeholder keeps today's behaviour.** While the constant is all
   zeros the updater fetches no signature and the workflow only warns when the
   secret is missing. Once it is real, the workflow fails a release whose
   secret is missing or does not match the constant, so a feed the app would
   refuse is never published.
5. **Rotation through a bridge release** (`NEKKO_RELEASE_KEY_ROTATION=1`): one
   release builds in the new key while its feed is still signed with the old
   one ([docs/signing.md](../signing.md#rotating-it)).

## Options considered

1. **One Ed25519 key, detached `.sig` files (chosen).** Small, no format
   change, verifiable in Rust with the `ed25519-dalek` crate nekkod already
   used, and in Node with no package.
2. **A key per purpose (feed, policy).** Two secrets to guard and rotate for
   the same trust statement ("this came from our release job"), with no
   separation gained: both are produced by the same workflow.
3. **Signing inside the YAML** (a `signature:` field). Requires canonicalizing
   YAML or signing a subset, and changes a file electron-builder owns.
4. **Sigstore / minisign.** More moving parts (a transparency log, a new
   binary in CI) for one key held by one owner.
5. **Accept several embedded keys** to make rotation seamless. Rejected for
   now: one constant is easier to audit, and rotation is rare.

## Consequences

- Until Philip generates the key and replaces the constant, nothing changes
  for users; the code paths are tested with test keys.
- After that, a release cannot publish without the secret, and every feed is
  checked by every install built with the key.
- An install that misses a rotation's bridge release must download the next
  release by hand once.
- The same key can now sign `claude-policy.json`; there is still no script for
  making a policy document (out of scope here).
