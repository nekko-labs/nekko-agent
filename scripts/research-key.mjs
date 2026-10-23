#!/usr/bin/env node
// The research key for "Help improve Nekko Agent" (docs/research-key-ceremony.md).
//
// Donations are sealed on users' devices to this key's public half
// (crates/nekko-sync `seal_donation`: ECIES over P-256, HKDF-SHA256, AES-256-GCM).
// The private half must only ever exist on an offline machine. This script runs
// there, with Node and nothing else: no network, no dependencies.
//
//   node scripts/research-key.mjs generate <private-key-file>
//       Make the key pair. Writes the private key (PKCS#8 PEM, mode 0600) and
//       prints the public half (base64url, 65 bytes) and its fingerprint.
//   node scripts/research-key.mjs public <private-key-file>
//       Print the public half again.
//   node scripts/research-key.mjs open <private-key-file> <donations.json> [out.json]
//       Open exported donations ([{ id, blob }]) and write their plaintexts.

import { createECDH, createDecipheriv, createHash, createPrivateKey, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const b64 = (s) => Buffer.from(s, 'base64url');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** As `nekko_sync::fingerprint`: the first 10 bytes of SHA-256, Crockford base32, groups of four. */
export function fingerprint(publicKey) {
  const d = createHash('sha256').update(publicKey).digest().subarray(0, 10);
  let bits = 0, acc = 0, out = '';
  for (const byte of d) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += ALPHABET[(acc >> bits) & 31]; } }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

/** The raw 32-byte scalar of a PKCS#8 P-256 key. */
export function scalarOf(pem) {
  const jwk = createPrivateKey(pem).export({ format: 'jwk' });
  if (jwk.crv !== 'P-256') throw new Error('not a P-256 key');
  return b64(jwk.d);
}

export function publicOf(scalar) {
  const e = createECDH('prime256v1');
  e.setPrivateKey(scalar);
  return e.getPublicKey();
}

/** Open one donation: `seal_to(research, "nekko-donation/v1\n<id>", frame(payload))`. */
export function openDonation(scalar, id, blob) {
  const raw = b64(blob);
  if (raw[0] !== 1 || raw.length < 1 + 65 + 16) throw new Error('malformed');
  const eph = raw.subarray(1, 66);
  const e = createECDH('prime256v1');
  e.setPrivateKey(scalar);
  const shared = e.computeSecret(eph);
  const ctx = Buffer.from(`nekko-donation/v1\n${id}`);
  const okm = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, e.getPublicKey()]), ctx, 44));
  const d = createDecipheriv('aes-256-gcm', okm.subarray(0, 32), okm.subarray(32));
  d.setAAD(ctx);
  const ct = raw.subarray(66);
  d.setAuthTag(ct.subarray(-16));
  const framed = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return framed.subarray(4, 4 + framed.readUInt32BE(0)).toString('utf8');
}

function main([cmd, keyFile, input, output]) {
  if (cmd === 'generate' && keyFile) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    writeFileSync(keyFile, pem, { mode: 0o600, flag: 'wx' });
    const pub = publicOf(scalarOf(pem));
    console.log(`private key written to ${keyFile} (keep it on this offline machine only)`);
    console.log(`public key:  ${pub.toString('base64url')}`);
    console.log(`fingerprint: ${fingerprint(pub)}`);
    return;
  }
  if (cmd === 'public' && keyFile) {
    const pub = publicOf(scalarOf(readFileSync(keyFile, 'utf8')));
    console.log(`public key:  ${pub.toString('base64url')}`);
    console.log(`fingerprint: ${fingerprint(pub)}`);
    return;
  }
  if (cmd === 'open' && keyFile && input) {
    const scalar = scalarOf(readFileSync(keyFile, 'utf8'));
    const list = JSON.parse(readFileSync(input, 'utf8'));
    const opened = list.map(({ id, blob }) => {
      try { return { id, payload: JSON.parse(openDonation(scalar, id, blob)) }; } catch (e) { return { id, error: String(e.message ?? e) }; }
    });
    writeFileSync(output ?? 'donations-opened.json', `${JSON.stringify(opened, null, 2)}\n`, { mode: 0o600 });
    console.log(`opened ${opened.filter((o) => !o.error).length} of ${opened.length}`);
    return;
  }
  console.error('usage: research-key.mjs generate|public <private-key-file> | open <private-key-file> <donations.json> [out.json]');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
