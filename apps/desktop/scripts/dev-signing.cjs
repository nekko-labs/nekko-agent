// The code-signing identity for development builds on macOS.
//
// The Keychain remembers an "Always Allow" for a program by its designated
// requirement. An ad-hoc signature's requirement is the binary's own hash, so
// every rebuild of nekkod is a new program to the Keychain and asks again for
// each item. A certificate's requirement names the certificate instead, so a
// build signed with the same one keeps that answer.
//
// The item's partition list is a second check: it names a team ID, or without
// one the binary's hash. A self-signed certificate has no team ID (codesign
// ignores its OU), so each rebuild still asks once there. Checked on macOS 27
// with a probe in a throwaway keychain (#2471).
//
// `scripts/dev-signing-identity.sh` creates that certificate once per Mac
// ("Nekko Agent Development", self-signed, in the login keychain).
// Set nekko.devSigningIdentity in the repository's local Git config to keep
// using an existing identity, or set NEKKO_DEV_SIGN_IDENTITY to override it.
// Neither selects a personal signing key unless the developer opts in.
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const DEV_IDENTITY = 'Nekko Agent Development';
const repo = resolve(__dirname, '../../..');
/** The identifier nekkod is signed with, stable across builds and checkouts. */
const DAEMON_IDENTIFIER = 'dev.nekkolabs.nekkod';

/** What `codesign --sign` should use, or null for ad-hoc. */
function devSigningIdentity(env = process.env, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin') return null;
  let chosen = env.NEKKO_DEV_SIGN_IDENTITY;
  if (!chosen && !env.CI) {
    // Resolve from the source tree, not the caller's cwd (often apps/desktop).
    // A linked worktree shares the repository's local config.
    const local = run('git', ['-C', repo, 'config', '--local', '--get', 'nekko.devSigningIdentity'], { encoding: 'utf8' });
    if (local.status === 0) chosen = local.stdout.trim();
  }
  if (chosen) return chosen === '-' ? null : chosen;
  const found = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.includes(`"${DEV_IDENTITY}"`) ? DEV_IDENTITY : null;
}

/**
 * Sign a development nekkod with the stable identity, if there is one. False
 * (with the reason printed) when it stays ad-hoc: it still runs, but macOS
 * asks twice for Keychain access after each rebuild.
 */
function signDevDaemon(path, env = process.env) {
  if (process.platform !== 'darwin') return true;
  const identity = devSigningIdentity(env);
  if (!identity) {
    console.warn('nekkod has no stable signing identity, so macOS can ask twice for Keychain access after each rebuild. '
      + 'Set nekko.devSigningIdentity to an Apple Development identity, or run apps/desktop/scripts/dev-signing-identity.sh '
      + 'to reduce it to one prompt per rebuild (docs/signing.md, "Development builds").');
    return false;
  }
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', identity, '--identifier', DAEMON_IDENTIFIER, path], { stdio: 'inherit' });
  if (signed.status !== 0) {
    console.warn(`codesign with "${identity}" failed: nekkod keeps its ad-hoc signature, and macOS asks again for Keychain access after this rebuild`);
    return false;
  }
  return true;
}

module.exports = { DEV_IDENTITY, DAEMON_IDENTIFIER, devSigningIdentity, signDevDaemon };
