import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  embeddedKey,
  generate,
  isPlaceholder,
  privateKeyFromSecret,
  publicKeyBytes,
  publicKeyFromBytes,
  rustConstant,
  signBytes,
  verifyBytes,
} from './release-key.mjs';
import { signFeeds } from './sign-update-feed.mjs';

const vector = JSON.parse(
  readFileSync(new URL('../crates/nekko-native/tests/golden/feed-signature.json', import.meta.url), 'utf8'),
);

function releaseDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-sign-feed-'));
  writeFileSync(join(dir, 'latest.yml'), vector.feed);
  writeFileSync(join(dir, 'latest-linux-arm64.yml'), 'version: 1.2.3\n');
  writeFileSync(join(dir, 'NekkoAgent-1.2.3-x64.exe'), 'installer');
  writeFileSync(join(dir, 'latest.yml.blockmap'), 'x');
  return dir;
}

function quiet() {
  const out = { log: [], warn: [] };
  return { out, log: (s) => out.log.push(s), warn: (s) => out.warn.push(s) };
}

test('reproduces the signature the Rust updater verifies', () => {
  const key = privateKeyFromSecret(vector.seed);
  assert.equal(publicKeyBytes(key).toString('base64'), vector.publicKey);
  assert.equal(signBytes(key, Buffer.from(vector.feed)), vector.signature);
});

test('the embedded key is read from release_key.rs, placeholder included', () => {
  assert.equal(embeddedKey().length, 32);
  assert.ok(isPlaceholder(embeddedKey('pub const RELEASE_SIGNING_KEY: [u8; 32] = [0; 32];')));
  const { publicKey } = generate();
  assert.deepEqual(embeddedKey(`// x\n${rustConstant(publicKey)}\n`), publicKey);
  assert.throws(() => embeddedKey('pub const RELEASE_SIGNING_KEY: [u8; 32] = [1, 2];'));
});

test('a generated key round-trips through the secret format', () => {
  const { seed, publicKey } = generate();
  const key = privateKeyFromSecret(seed);
  assert.deepEqual(publicKeyBytes(key), publicKey);
  const pem = key.export({ format: 'pem', type: 'pkcs8' });
  assert.deepEqual(publicKeyBytes(privateKeyFromSecret(pem)), publicKey);
  assert.ok(verifyBytes(publicKeyFromBytes(publicKey), Buffer.from('a'), signBytes(key, Buffer.from('a'))));
  assert.throws(() => privateKeyFromSecret('c2hvcnQ='));
});

test('placeholder key and no secret: skips with a warning', () => {
  const dir = releaseDir();
  const q = quiet();
  const r = signFeeds(dir, { secret: '', embedded: Buffer.alloc(32), ...q });
  assert.equal(r.code, 0);
  assert.deepEqual(r.written, []);
  assert.match(q.out.warn[0], /^::warning::NEKKO_RELEASE_SIGNING_KEY is not set/);
  assert.ok(!existsSync(join(dir, 'latest.yml.sig')));
  rmSync(dir, { recursive: true });
});

test('real key and no secret: fails', () => {
  const dir = releaseDir();
  const q = quiet();
  const r = signFeeds(dir, { embedded: Buffer.from(vector.publicKey, 'base64'), ...q });
  assert.equal(r.code, 1);
  assert.match(q.out.warn[0], /^::error::/);
  rmSync(dir, { recursive: true });
});

test('real key and the matching secret: signs every feed file and nothing else', () => {
  const dir = releaseDir();
  const q = quiet();
  const r = signFeeds(dir, { secret: vector.seed, embedded: Buffer.from(vector.publicKey, 'base64'), ...q });
  assert.equal(r.code, 0);
  assert.deepEqual(r.written, [join(dir, 'latest-linux-arm64.yml.sig'), join(dir, 'latest.yml.sig')]);
  assert.equal(readFileSync(join(dir, 'latest.yml.sig'), 'utf8'), vector.signature);
  assert.ok(!existsSync(join(dir, 'latest.yml.blockmap.sig')));
  rmSync(dir, { recursive: true });
});

test('a secret that does not match the built-in key fails', () => {
  const dir = releaseDir();
  const q = quiet();
  const r = signFeeds(dir, { secret: generate().seed, embedded: Buffer.from(vector.publicKey, 'base64'), ...q });
  assert.equal(r.code, 1);
  assert.match(q.out.warn[0], /does not match the key built into the app/);
  assert.ok(!existsSync(join(dir, 'latest.yml.sig')));
  rmSync(dir, { recursive: true });
});

test('placeholder key with a secret: signs, with a warning', () => {
  const dir = releaseDir();
  const q = quiet();
  const r = signFeeds(dir, { secret: vector.seed, embedded: Buffer.alloc(32), ...q });
  assert.equal(r.code, 0);
  assert.equal(r.written.length, 2);
  assert.match(q.out.warn[0], /^::warning::/);
  rmSync(dir, { recursive: true });
});

test('a secret but no feed file fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-sign-feed-'));
  const q = quiet();
  assert.equal(signFeeds(dir, { secret: vector.seed, embedded: Buffer.from(vector.publicKey, 'base64'), ...q }).code, 1);
  rmSync(dir, { recursive: true });
});

test('a key rotation bridge release may sign with the previous key', () => {
  const dir = releaseDir();
  const q = quiet();
  const embedded = generate().publicKey;
  const r = signFeeds(dir, { secret: vector.seed, embedded, rotating: true, ...q });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dir, 'latest.yml.sig'), 'utf8'), vector.signature);
  assert.match(q.out.warn[0], /rotation/);
  rmSync(dir, { recursive: true });
});
