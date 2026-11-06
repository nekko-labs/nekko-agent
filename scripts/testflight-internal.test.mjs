import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertInternalOnly, internalGroupsToAdd, makeToken, processingVerdict } from './testflight-internal.mjs';

const group = (id, isInternalGroup, hasAccessToAllBuilds = false) => ({ id, attributes: { name: id, isInternalGroup, hasAccessToAllBuilds } });
const groups = [group('team', true), group('auto', true, true), group('public', false), group('friends', false, true)];

test('only internal groups without automatic distribution get the build', () => {
  assert.deepEqual(internalGroupsToAdd(groups).map(g => g.id), ['team']);
  assert.deepEqual(internalGroupsToAdd([group('public', false)]), []);
});

test('the write is refused for any group that is not internal', () => {
  assert.doesNotThrow(() => assertInternalOnly(['team', 'auto'], groups));
  assert.throws(() => assertInternalOnly(['team', 'public'], groups), /non-internal group\(s\): public/);
  assert.throws(() => assertInternalOnly(['unknown'], groups), /unknown/);
});

test('processing states: wait, ready, or a named failure', () => {
  assert.equal(processingVerdict(undefined), 'wait');
  assert.equal(processingVerdict({ attributes: { processingState: 'PROCESSING' } }), 'wait');
  assert.equal(processingVerdict({ attributes: { processingState: 'VALID' } }), 'ready');
  assert.match(processingVerdict({ attributes: { processingState: 'INVALID' } }), /INVALID/);
});

test('the API token is an ES256 JWT Apple accepts in shape, signed by the key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = makeToken({ keyPem, keyId: 'ABC123', issuer: 'issuer-uuid', now: 1_000 });
  const [h, p, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'issuer-uuid', iat: 1_000, exp: 2_200, aud: 'appstoreconnect-v1' });
  const sig = Buffer.from(s, 'base64url');
  assert.equal(sig.length, 64); // raw r||s, not DER
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig));
});

test('the script has no path to external testing or Beta App Review', () => {
  const src = readFileSync(new URL('./testflight-internal.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  for (const banned of ['betaAppReviewSubmissions', 'betaTesters', 'publicLink', "method: 'PATCH'", "method: 'DELETE'"]) {
    assert.ok(!code.includes(banned), banned);
  }
  // One write, to a build's betaGroups, behind the internal-only guard.
  assert.equal(code.match(/method: '(POST|PATCH|PUT|DELETE)'/g)?.length, 1);
  assert.ok(code.indexOf('assertInternalOnly(add') < code.indexOf("method: 'POST'"));
});
