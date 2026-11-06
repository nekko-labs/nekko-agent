// Hands a just-uploaded iOS build to the internal TestFlight groups, and only
// those (Philip, 2026-11-06: nightly builds are for internal testing only;
// docs/decisions/0055).
//
// Waits for App Store Connect to finish processing the build, then adds it to
// every internal group that does not already get every build automatically.
// It never touches an external group and never submits for Beta App Review:
// the only write it can make is POST /v1/builds/{id}/relationships/betaGroups,
// and only with internal group ids (assertInternalOnly).
//
// Usage (ios-testflight.yml, after the upload):
//   node scripts/testflight-internal.mjs --bundle-id dev.nekkolabs.nekkoagent \
//     --version 0.8.1 --build 80001 [--dry-run] [--wait-minutes 45]
// Reads APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER from the environment.

import { createPrivateKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com';

const b64url = buf => Buffer.from(buf).toString('base64url');

/** An App Store Connect API token (ES256 JWT, 20 minutes, the most Apple allows). */
export function makeToken({ keyPem, keyId, issuer, now = Math.floor(Date.now() / 1000) }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * The internal groups to add a build to: internal, and not already given every
 * build by App Store Connect (hasAccessToAllBuilds, "automatic distribution").
 * External groups are never returned.
 */
export function internalGroupsToAdd(groups) {
  return groups.filter(g => g.attributes?.isInternalGroup === true && g.attributes?.hasAccessToAllBuilds !== true);
}

/** Throws unless every id names an internal group: the guard on the only write. */
export function assertInternalOnly(ids, groups) {
  const internal = new Set(groups.filter(g => g.attributes?.isInternalGroup === true).map(g => g.id));
  const bad = ids.filter(id => !internal.has(id));
  if (bad.length) throw new Error(`Refusing to add the build to non-internal group(s): ${bad.join(', ')}`);
}

/** What processingState means for the wait: 'wait', 'ready' or a failure message. */
export function processingVerdict(build) {
  if (!build) return 'wait'; // not listed yet: Apple shows it a few minutes after the upload
  const s = build.attributes?.processingState;
  if (s === 'VALID') return 'ready';
  if (s === 'PROCESSING') return 'wait';
  return `App Store Connect marked the build ${s}`;
}

async function api(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main(o) {
  const creds = { keyPem: process.env.APPLE_API_KEY_P8, keyId: process.env.APPLE_API_KEY_ID, issuer: process.env.APPLE_API_ISSUER };
  if (!creds.keyPem || !creds.keyId || !creds.issuer) throw new Error('APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER are required.');
  const token = () => makeToken(creds); // fresh per call: the wait outlives one token

  const apps = await api(token(), `/v1/apps?filter[bundleId]=${encodeURIComponent(o.bundleId)}&fields[apps]=bundleId`);
  const app = apps.data.find(a => a.attributes.bundleId === o.bundleId);
  if (!app) throw new Error(`No App Store Connect app with bundle id ${o.bundleId}.`);

  const deadline = Date.now() + o.waitMinutes * 60_000;
  let build;
  for (;;) {
    const q = `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(o.build)}`
      + `&filter[preReleaseVersion.version]=${encodeURIComponent(o.version)}&fields[builds]=version,processingState`;
    build = (await api(token(), q)).data[0];
    const v = processingVerdict(build);
    if (v === 'ready') break;
    if (v !== 'wait') throw new Error(`${o.version} (${o.build}): ${v}.`);
    if (Date.now() > deadline) {
      console.log(`::warning::${o.version} (${o.build}) was still processing after ${o.waitMinutes} minutes; add it to the internal groups in App Store Connect once it finishes.`);
      return;
    }
    console.log(`${o.version} (${o.build}): ${build ? 'processing' : 'not listed yet'}; checking again in a minute.`);
    await new Promise(r => setTimeout(r, 60_000));
  }

  const groups = (await api(token(), `/v1/apps/${app.id}/betaGroups?fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds&limit=200`)).data;
  const auto = groups.filter(g => g.attributes.isInternalGroup && g.attributes.hasAccessToAllBuilds).map(g => g.attributes.name);
  const add = internalGroupsToAdd(groups);
  const external = groups.filter(g => !g.attributes.isInternalGroup).map(g => g.attributes.name);
  console.log(`Internal groups that get every build already: ${auto.join(', ') || 'none'}.`);
  console.log(`External groups, left alone: ${external.join(', ') || 'none'}.`);
  if (!add.length) {
    if (!auto.length) console.log('::warning::No internal TestFlight group exists; create one in App Store Connect.');
    return;
  }
  assertInternalOnly(add.map(g => g.id), groups);
  const names = add.map(g => g.attributes.name).join(', ');
  if (o.dryRun) { console.log(`Dry run: would add ${o.version} (${o.build}) to ${names}.`); return; }
  await api(token(), `/v1/builds/${build.id}/relationships/betaGroups`, {
    method: 'POST', body: JSON.stringify({ data: add.map(g => ({ type: 'betaGroups', id: g.id })) }),
  });
  console.log(`Added ${o.version} (${o.build}) to ${names}.`);
}

function parseArgs(argv) {
  const o = { dryRun: false, waitMinutes: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle-id') o.bundleId = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--build') o.build = argv[++i];
    else if (a === '--wait-minutes') o.waitMinutes = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!o.bundleId || !o.version || !o.build) throw new Error('--bundle-id, --version and --build are required.');
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(parseArgs(process.argv.slice(2))).catch(err => { console.error(err.message); process.exit(1); });
}
