// Usage: node apps/desktop/scripts/check-provisioning-profile.cjs <file.provisionprofile>
//        node apps/desktop/scripts/check-provisioning-profile.cjs --app <Nekko Agent.app>
//
// Checks that a provisioning profile can sign the macOS release: a Developer ID
// profile for macOS that authorizes every restricted entitlement
// (keychain-access-groups, com.apple.application-identifier, com.apple.developer.*).
// macOS refuses to launch the app when it does not (#2688), and nothing before
// launch notices. Exits non-zero on any problem and warns when the profile
// expires within 30 days. macOS only (security, plutil, codesign).
//
// With a file, the entitlements are build/entitlements.mac.plist: release CI
// runs this on the MACOS_PROVISIONING_PROFILE secret before building. With
// --app, they are what the built app's main executable carries, the profile is
// its Contents/embedded.provisionprofile, and the profile must also be issued
// for the certificate the app is signed with: scripts/check-mac-entitlements.sh
// runs this on the built app. See docs/signing.md, "Provisioning profile".
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const MAIN_ENTITLEMENTS = join(__dirname, '..', 'build', 'entitlements.mac.plist');
const WARN_DAYS = 30;
const RESTRICTED = /^(keychain-access-groups|com\.apple\.application-identifier|com\.apple\.developer\..+)$/;
const DAY = 24 * 60 * 60 * 1000;

/** Whether a profile value (`3HM5598S99.*` or exact) authorizes a wanted one. */
function grants(pattern, value) {
  return pattern === value || (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1)));
}

/** Whether a profile entitlement (a pattern, a list of them, or a boolean) authorizes one carried value. */
function authorizes(allowed, value) {
  if (typeof value === 'boolean') return allowed === value;
  return [allowed].flat().some((p) => typeof p === 'string' && typeof value === 'string' && grants(p, value));
}

/** One message per restricted entitlement value in `carried` that `allowed` (the profile's Entitlements) does not authorize. */
function ungranted(carried, allowed) {
  const errors = [];
  for (const [key, value] of Object.entries(carried)) {
    if (!RESTRICTED.test(key)) continue;
    for (const v of Array.isArray(value) ? value : [value])
      if (!authorizes(allowed[key], v)) errors.push(`${key} ${JSON.stringify(v)} is not authorized (profile allows ${JSON.stringify(allowed[key] ?? null)}).`);
  }
  return errors;
}

/** Whether the profile was issued for the signing certificate (DER bytes). macOS matches them at launch. */
function issuedFor(certificates, leaf) {
  return (certificates ?? []).some((c) => Buffer.compare(c, leaf) === 0);
}

/**
 * What is wrong with a decoded profile for these entitlements.
 * `profile`: Platform, ProvisionsAllDevices, TeamIdentifier, Entitlements, ExpirationDate (a Date), Name.
 * `wanted`: the main executable's entitlements (build/entitlements.mac.plist, or what a built app carries).
 */
function checkProfile(profile, wanted, now = new Date()) {
  const errors = [];
  const warnings = [];
  const team = wanted['com.apple.developer.team-identifier'];
  const appId = wanted['com.apple.application-identifier'];
  const ents = profile.Entitlements ?? {};
  if (!team || !appId) return { errors: ['The entitlements name no team identifier and application identifier to check the profile against.'], warnings };

  if (!(profile.Platform ?? []).includes('OSX')) errors.push(`Not a macOS profile (Platform ${JSON.stringify(profile.Platform)}).`);
  if (profile.ProvisionsAllDevices !== true) errors.push('Not a Developer ID profile (ProvisionsAllDevices is not true). Create it under Distribution → Developer ID.');
  if (!(profile.TeamIdentifier ?? []).includes(team)) errors.push(`Team ${JSON.stringify(profile.TeamIdentifier)} is not ${team}.`);

  if (ents['com.apple.application-identifier'] !== appId)
    errors.push(`Application identifier ${JSON.stringify(ents['com.apple.application-identifier'])} is not ${appId}. Pick App ID ${appId.slice(team.length + 1)}.`);
  if (ents['com.apple.developer.team-identifier'] !== team)
    errors.push(`Entitlement team identifier ${JSON.stringify(ents['com.apple.developer.team-identifier'])} is not ${team}.`);

  // The two identifiers are checked exactly above; every other restricted key, generically.
  const exact = new Set(['com.apple.application-identifier', 'com.apple.developer.team-identifier']);
  errors.push(...ungranted(Object.fromEntries(Object.entries(wanted).filter(([k]) => !exact.has(k))), ents));

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

/** Every <data> item of an array key, as Buffers (plutil prints <data> as base64 in raw format). */
function extractData(file, key) {
  const out = [];
  for (let i = 0, b64; (b64 = extract(file, `${key}.${i}`, 'raw')) !== undefined; i++) out.push(Buffer.from(b64, 'base64'));
  return out;
}

/** The fields checkProfile and issuedFor read, from a decoded profile plist. Whole-plist JSON conversion fails on its <data> and <date> values, so read key by key. */
function readDecoded(plist) {
  const expires = extract(plist, 'ExpirationDate', 'raw');
  return {
    DeveloperCertificates: extractData(plist, 'DeveloperCertificates'),
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

/** What a built app's main executable carries, and the leaf certificate it is signed with. */
function readApp(app) {
  const dir = mkdtempSync(join(tmpdir(), 'app-'));
  try {
    const plist = join(dir, 'entitlements.plist');
    writeFileSync(plist, execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', app], { stdio: ['ignore', 'pipe', 'ignore'] }));
    const carried = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    execFileSync('codesign', ['-d', `--extract-certificates=${join(dir, 'cert')}`, app], { stdio: 'ignore' });
    let leaf;
    try {
      leaf = readFileSync(join(dir, 'cert0'));
    } catch {
      throw new Error(`${app} is not signed with a certificate.`);
    }
    return { carried, leaf };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const [first, second] = process.argv.slice(2);
  const app = first === '--app' ? second : undefined;
  const file = app ? join(app, 'Contents', 'embedded.provisionprofile') : first;
  if (!file || (first === '--app' && !app)) throw new Error('usage: check-provisioning-profile.cjs <file.provisionprofile> | --app <app>');

  const { carried: wanted, leaf } = app
    ? readApp(app)
    : { carried: JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', MAIN_ENTITLEMENTS], { encoding: 'utf8' })) };
  const profile = readProfile(file);
  const { errors, warnings } = checkProfile(profile, wanted);
  if (leaf && !issuedFor(profile.DeveloperCertificates, leaf))
    errors.push('The profile was not issued for the certificate the app is signed with. Regenerate it for that certificate.');

  for (const w of warnings) console.warn(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(app
      ? `${app} embeds a profile that does not authorize its main executable, so macOS will refuse to launch it. docs/signing.md, "Provisioning profile".`
      : 'This profile cannot sign the macOS release. docs/signing.md, "Provisioning profile".');
    process.exit(1);
  }
  console.log(`provisioning profile OK: "${profile.Name}", ${wanted['com.apple.application-identifier']}, expires ${profile.ExpirationDate.toISOString()}${app ? ', issued for the signing certificate' : ''}`);
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
exports.issuedFor = issuedFor;
exports.ungranted = ungranted;
exports.readDecoded = readDecoded;
exports.MAIN_ENTITLEMENTS = MAIN_ENTITLEMENTS;
