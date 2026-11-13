// Usage: node apps/desktop/scripts/check-provisioning-profile.cjs <file.provisionprofile>
//
// Checks that a provisioning profile can sign the macOS release: a Developer ID
// profile for macOS that authorizes every restricted entitlement in
// build/entitlements.mac.plist (application identifier, team identifier,
// keychain access group). macOS refuses to launch the app when it does not
// (#2688), and nothing before launch notices. Exits non-zero on any problem and
// warns when the profile expires within 30 days. Release CI runs it on the
// MACOS_PROVISIONING_PROFILE secret before building. macOS only (security,
// plutil). See docs/signing.md, "Provisioning profile".
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const MAIN_ENTITLEMENTS = join(__dirname, '..', 'build', 'entitlements.mac.plist');
const WARN_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** Whether a profile value (`3HM5598S99.*` or exact) authorizes a wanted one. */
function grants(pattern, value) {
  return pattern === value || (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1)));
}

/**
 * What is wrong with a decoded profile for these entitlements.
 * `profile`: Platform, ProvisionsAllDevices, TeamIdentifier, Entitlements, ExpirationDate (a Date), Name.
 * `wanted`: the main executable's entitlements (build/entitlements.mac.plist).
 */
function checkProfile(profile, wanted, now = new Date()) {
  const errors = [];
  const warnings = [];
  const team = wanted['com.apple.developer.team-identifier'];
  const appId = wanted['com.apple.application-identifier'];
  const groups = wanted['keychain-access-groups'] ?? [];
  const ents = profile.Entitlements ?? {};

  if (!(profile.Platform ?? []).includes('OSX')) errors.push(`Not a macOS profile (Platform ${JSON.stringify(profile.Platform)}).`);
  if (profile.ProvisionsAllDevices !== true) errors.push('Not a Developer ID profile (ProvisionsAllDevices is not true). Create it under Distribution → Developer ID.');
  if (!(profile.TeamIdentifier ?? []).includes(team)) errors.push(`Team ${JSON.stringify(profile.TeamIdentifier)} is not ${team}.`);

  if (ents['com.apple.application-identifier'] !== appId)
    errors.push(`Application identifier ${JSON.stringify(ents['com.apple.application-identifier'])} is not ${appId}. Pick App ID ${appId.slice(team.length + 1)}.`);
  if (ents['com.apple.developer.team-identifier'] !== team)
    errors.push(`Entitlement team identifier ${JSON.stringify(ents['com.apple.developer.team-identifier'])} is not ${team}.`);

  const allowed = ents['keychain-access-groups'] ?? [];
  for (const group of groups)
    if (!allowed.some((p) => grants(p, group))) errors.push(`Keychain access group ${group} is not authorized (profile allows ${JSON.stringify(allowed)}).`);

  const expires = profile.ExpirationDate;
  if (!(expires instanceof Date) || Number.isNaN(expires.getTime())) errors.push('No expiration date.');
  else if (expires <= now) errors.push(`Expired on ${expires.toISOString()}. Regenerate it in the developer portal.`);
  else if (expires - now < WARN_DAYS * DAY) warnings.push(`Expires on ${expires.toISOString()}, in under ${WARN_DAYS} days. Regenerate it in the developer portal.`);

  return { errors, warnings };
}

/** One key of a plist file as JSON (or a raw string), undefined when absent. */
function extract(file, key, format = 'json') {
  try {
    const out = execFileSync('plutil', ['-extract', key, format, '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return format === 'json' ? JSON.parse(out) : out.trim();
  } catch {
    return undefined;
  }
}

/** The fields checkProfile reads, from a decoded profile plist. Whole-plist JSON conversion fails on its <data> and <date> values, so read key by key. */
function readDecoded(plist) {
  const expires = extract(plist, 'ExpirationDate', 'raw');
  return {
    Name: extract(plist, 'Name', 'raw'),
    Platform: extract(plist, 'Platform'),
    // raw, not json: plutil refuses a bare boolean as JSON.
    ProvisionsAllDevices: extract(plist, 'ProvisionsAllDevices', 'raw') === 'true',
    TeamIdentifier: extract(plist, 'TeamIdentifier'),
    Entitlements: extract(plist, 'Entitlements'),
    ExpirationDate: expires ? new Date(expires) : undefined,
  };
}

/** Decode a .provisionprofile (a CMS-signed plist) and read it. */
function readProfile(path) {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  try {
    const plist = join(dir, 'profile.plist');
    execFileSync('security', ['cms', '-D', '-i', path, '-o', plist], { stdio: ['ignore', 'ignore', 'inherit'] });
    return readDecoded(plist);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: check-provisioning-profile.cjs <file.provisionprofile>');
  const wanted = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', MAIN_ENTITLEMENTS], { encoding: 'utf8' }));
  const profile = readProfile(file);
  const { errors, warnings } = checkProfile(profile, wanted);
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error('This profile cannot sign the macOS release. docs/signing.md, "Provisioning profile".');
    process.exit(1);
  }
  console.log(`provisioning profile OK: "${profile.Name}", ${wanted['com.apple.application-identifier']}, expires ${profile.ExpirationDate.toISOString()}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`provisioning profile check failed: ${e.message}`);
    process.exit(1);
  }
}

exports.checkProfile = checkProfile;
exports.grants = grants;
exports.readDecoded = readDecoded;
exports.MAIN_ENTITLEMENTS = MAIN_ENTITLEMENTS;
