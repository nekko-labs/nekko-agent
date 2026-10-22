import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fingerprint, openDonation, publicOf } from './research-key.mjs';

const vectors = JSON.parse(readFileSync(new URL('../crates/nekko-sync/tests/golden/sync-crypto.json', import.meta.url), 'utf8'));

test('opens the donation the Rust and Swift sealers make', () => {
  const d = vectors.donation;
  const scalar = Buffer.from(d.researchPrivate, 'base64url');
  assert.equal(publicOf(scalar).toString('base64url'), d.researchPublic);
  assert.equal(openDonation(scalar, d.id, d.blob), d.payload);
  assert.throws(() => openDonation(scalar, 'another-id', d.blob));
});

test('fingerprints match nekko-sync', () => {
  assert.equal(fingerprint(Buffer.from(vectors.device.public, 'base64url')), vectors.device.fingerprint);
});

test('reads the scalar out of a PEM it generated', async () => {
  const { scalarOf } = await import('./research-key.mjs');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.equal(scalarOf(pem).length, 32);
  assert.ok(createPrivateKey(pem));
});
