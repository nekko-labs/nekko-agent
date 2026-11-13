const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkProfile, grants, readDecoded, MAIN_ENTITLEMENTS } = require('./check-provisioning-profile.cjs');

const TEAM = '3HM5598S99';
const NOW = new Date('2026-11-13T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const wanted = {
  'com.apple.application-identifier': `${TEAM}.dev.nekkolabs.nekkoagent`,
  'com.apple.developer.team-identifier': TEAM,
  'keychain-access-groups': [`${TEAM}.dev.nekkolabs.nekkoagent.webauthn`],
};

// What the portal issues for Distribution → Developer ID on that App ID.
const developerId = (over = {}) => ({
  Name: 'Nekko Agent Developer ID',
  Platform: ['OSX'],
  ProvisionsAllDevices: true,
  TeamIdentifier: [TEAM],
  ExpirationDate: new Date(NOW.getTime() + 365 * DAY),
  ...over,
  Entitlements: {
    'com.apple.application-identifier': `${TEAM}.dev.nekkolabs.nekkoagent`,
    'com.apple.developer.team-identifier': TEAM,
    'keychain-access-groups': [`${TEAM}.*`],
    ...over.Entitlements,
  },
});

const errors = (p) => checkProfile(p, wanted, NOW).errors;

test('a_developer_id_profile_for_the_app_passes', () => {
  assert.deepEqual(checkProfile(developerId(), wanted, NOW), { errors: [], warnings: [] });
  const exact = developerId({ Entitlements: { 'keychain-access-groups': [`${TEAM}.dev.nekkolabs.nekkoagent.webauthn`] } });
  assert.deepEqual(errors(exact), []);
});

test('the_wrong_kind_of_profile_fails', () => {
  assert.match(errors(developerId({ Platform: ['iOS'] }))[0], /^Not a macOS profile/);
  assert.match(errors(developerId({ ProvisionsAllDevices: undefined }))[0], /^Not a Developer ID profile/);
  assert.match(errors(developerId({ TeamIdentifier: ['ABCDE12345'] }))[0], /is not 3HM5598S99\.$/);
});

test('a_profile_for_another_app_or_team_fails', () => {
  assert.match(errors(developerId({ Entitlements: { 'com.apple.application-identifier': `${TEAM}.dev.nekkolabs.other` } }))[0], /Pick App ID dev\.nekkolabs\.nekkoagent\.$/);
  assert.match(errors(developerId({ Entitlements: { 'com.apple.application-identifier': `${TEAM}.*` } }))[0], /^Application identifier/);
  assert.match(errors(developerId({ Entitlements: { 'com.apple.developer.team-identifier': 'ABCDE12345' } }))[0], /^Entitlement team identifier/);
});

test('a_profile_without_the_keychain_group_fails', () => {
  assert.match(errors(developerId({ Entitlements: { 'keychain-access-groups': undefined } }))[0], /^Keychain access group .*webauthn is not authorized/);
  assert.match(errors(developerId({ Entitlements: { 'keychain-access-groups': ['ABCDE12345.*'] } }))[0], /is not authorized/);
});

test('expiry_fails_when_past_and_warns_within_30_days', () => {
  assert.match(errors(developerId({ ExpirationDate: new Date(NOW.getTime() - 1) }))[0], /^Expired on/);
  assert.match(errors(developerId({ ExpirationDate: undefined }))[0], /^No expiration date/);
  const soon = checkProfile(developerId({ ExpirationDate: new Date(NOW.getTime() + 10 * DAY) }), wanted, NOW);
  assert.deepEqual(soon.errors, []);
  assert.match(soon.warnings[0], /in under 30 days/);
});

test('wildcards_match_by_prefix_only', () => {
  assert.equal(grants(`${TEAM}.*`, `${TEAM}.dev.nekkolabs.nekkoagent.webauthn`), true);
  assert.equal(grants(`${TEAM}.dev.*`, `${TEAM}.com.other`), false);
  assert.equal(grants(`${TEAM}.dev.nekkolabs.nekkoagent`, `${TEAM}.dev.nekkolabs.nekkoagent.webauthn`), false);
});

test('it_checks_what_the_main_entitlements_carry', () => {
  // The check reads build/entitlements.mac.plist, so these fixtures must stay what it holds.
  const plist = fs.readFileSync(MAIN_ENTITLEMENTS, 'utf8');
  assert.match(plist, new RegExp(`<key>com\\.apple\\.application-identifier</key>\\s*<string>${wanted['com.apple.application-identifier'].replaceAll('.', '\\.')}</string>`));
  assert.match(plist, new RegExp(`<key>com\\.apple\\.developer\\.team-identifier</key>\\s*<string>${TEAM}</string>`));
  assert.match(plist, new RegExp(`<key>keychain-access-groups</key>\\s*<array>\\s*<string>${wanted['keychain-access-groups'][0].replaceAll('.', '\\.')}</string>\\s*</array>`));
});

test('it_reads_a_decoded_profile_with_data_and_date_values', { skip: process.platform !== 'darwin' && 'plutil is macOS only' }, () => {
  // The shape `security cms -D` prints: <data> and <date> values that whole-plist JSON conversion rejects.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  const plist = path.join(dir, 'profile.plist');
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>DeveloperCertificates</key><array><data>AAEC</data></array>
  <key>Entitlements</key><dict>
    <key>com.apple.application-identifier</key><string>${TEAM}.dev.nekkolabs.nekkoagent</string>
    <key>com.apple.developer.team-identifier</key><string>${TEAM}</string>
    <key>keychain-access-groups</key><array><string>${TEAM}.*</string></array>
  </dict>
  <key>ExpirationDate</key><date>2027-11-13T05:00:00Z</date>
  <key>Name</key><string>Nekko Agent Developer ID</string>
  <key>Platform</key><array><string>OSX</string></array>
  <key>ProvisionsAllDevices</key><true/>
  <key>TeamIdentifier</key><array><string>${TEAM}</string></array>
</dict></plist>
`);
  try {
    const read = readDecoded(plist);
    assert.deepEqual(read, developerId({ ExpirationDate: new Date('2027-11-13T05:00:00Z') }));
    assert.deepEqual(checkProfile(read, wanted, NOW), { errors: [], warnings: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
