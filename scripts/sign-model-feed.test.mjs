import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate, privateKeyFromSecret, verifyBytes } from './release-key.mjs';
import { ASSET, LIST_SOURCE, feedDocument, feedSerial, signModelFeed } from './sign-model-feed.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'nekko-sign-model-feed-'));
function quiet() {
  const out = { log: [], warn: [] };
  return { out, log: (s) => out.log.push(s), warn: (s) => out.warn.push(s) };
}
const ZERO = Buffer.alloc(32);

test('a serial follows the list version, a day at a time and within a day', () => {
  assert.equal(feedSerial('2026-10-22.1'), 20261022001);
  assert.ok(feedSerial('2026-10-22.10') > feedSerial('2026-10-22.9'));
  assert.ok(feedSerial('2026-11-01.1') > feedSerial('2026-10-22.999'));
  assert.ok(Number.isSafeInteger(feedSerial('9999-12-31.999')));
  for (const bad of ['2026-10-22', '2026-10-22.1000', 'latest', '']) assert.throws(() => feedSerial(bad));
});

test('the shipped list has a version a serial can be made from', () => {
  const feed = JSON.parse(readFileSync(LIST_SOURCE, 'utf8'));
  const doc = feedDocument(feed);
  assert.equal(doc.type, 'nekko.modelFeed');
  assert.equal(doc.version, 1);
  assert.equal(doc.serial, feedSerial(feed.version));
  assert.match(doc.issuedAt, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
});

test('writes the document the daemon verifies: base64 payload and a signature over its bytes', () => {
  const d = dir();
  const { seed, publicKey } = generate();
  const q = quiet();
  const feed = { format: 1, version: '2026-11-20.2', models: [] };
  const res = signModelFeed(d, { secret: seed, embedded: publicKey, feed, ...q });
  assert.deepEqual(res, { code: 0, written: [join(d, ASSET)] });
  assert.deepEqual(q.out.log, [join(d, ASSET)]);
  const doc = JSON.parse(readFileSync(join(d, ASSET), 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['payload', 'signature']);
  const payload = Buffer.from(doc.payload, 'base64');
  // 64 signature bytes and nothing else: the daemon rejects any other length.
  assert.equal(Buffer.from(doc.signature, 'base64').length, 64);
  assert.equal(doc.signature, doc.signature.trim());
  assert.ok(verifyBytes(privateKeyFromSecret(seed), payload, doc.signature));
  assert.deepEqual(JSON.parse(payload.toString()), {
    type: 'nekko.modelFeed',
    version: 1,
    serial: 20261120002,
    issuedAt: '2026-11-20T00:00:00Z',
    feed,
  });
  // The same list signs to the same bytes, so each platform's release job uploads an identical file.
  const again = dir();
  signModelFeed(again, { secret: seed, embedded: publicKey, feed, ...quiet() });
  assert.equal(readFileSync(join(again, ASSET), 'utf8'), readFileSync(join(d, ASSET), 'utf8'));
  rmSync(d, { recursive: true });
  rmSync(again, { recursive: true });
});

test('publishes nothing while there is no key, and fails when the key and the app disagree', () => {
  const d = dir();
  const { seed, publicKey } = generate();
  const feed = { version: '2026-11-20.1' };
  let q = quiet();
  assert.deepEqual(signModelFeed(d, { secret: '', embedded: ZERO, feed, ...q }), { code: 0, written: [] });
  assert.match(q.out.warn[0], /no model list is published/);
  assert.equal(existsSync(join(d, ASSET)), false);

  q = quiet();
  assert.equal(signModelFeed(d, { secret: '', embedded: publicKey, feed, ...q }).code, 1);
  assert.match(q.out.warn[0], /cannot be signed/);

  q = quiet();
  assert.equal(signModelFeed(d, { secret: generate().seed, embedded: publicKey, feed, ...q }).code, 1);
  assert.match(q.out.warn[0], /does not match the key built into the app/);
  assert.equal(signModelFeed(d, { secret: generate().seed, embedded: publicKey, rotating: true, feed, ...quiet() }).code, 0);

  q = quiet();
  assert.equal(signModelFeed(d, { secret: seed, embedded: publicKey, feed: { version: 'soon' }, ...q }).code, 1);
  assert.match(q.out.warn[0], /is not YYYY-MM-DD\.N/);
  rmSync(d, { recursive: true });
});
