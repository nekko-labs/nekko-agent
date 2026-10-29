import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  STEP_UP_CHALLENGE,
  base32Decode,
  base32Encode,
  checkStepUp,
  derToRaw,
  emptySecurityState,
  hashRecoveryCode,
  newRecoveryCodes,
  rawToDer,
  stepUpRpId,
  toB64,
  toB64url,
  totpAt,
  totpStep,
  useRecoveryCode,
  type SecurityState,
  type StepUpIssued,
} from './step-up.js';

/**
 * `crates/nekko-remote/tests/golden/step-up.json`: real ES256 assertions from
 * a software FIDO2 authenticator (below), TOTP codes and recovery codes, with
 * what the TS verifier decided for each. The daemon's `step_up.rs` must
 * decide every case the same (crates/nekko-remote/tests/golden.rs), and the
 * phone apps' verifiers will read it too. UPDATE_GOLDEN=1 writes a fresh set
 * (ECDSA signatures are random, so the file changes each time); otherwise
 * the committed file is checked.
 */
const file = join(__dirname, '..', '..', '..', 'crates', 'nekko-remote', 'tests', 'golden', 'step-up.json');

const enc = new TextEncoder();
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/** A software FIDO2 authenticator holding one ES256 credential. */
async function authenticator(idByte: number) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const id = toB64url(new Uint8Array(16).fill(idByte));
  return {
    id,
    publicKey: toB64(publicKey),
    async assert(o: { rpId: string; challenge: string; origin: string; counter: number; flags?: number; type?: string }) {
      const auth = new Uint8Array(37);
      auth.set(await sha256(enc.encode(o.rpId)), 0);
      auth[32] = o.flags ?? 0x05;
      new DataView(auth.buffer).setUint32(33, o.counter);
      const cdj = enc.encode(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: o.challenge, origin: o.origin, crossOrigin: false }));
      const signed = new Uint8Array([...auth, ...(await sha256(cdj))]);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
      return { credentialId: id, authenticatorData: toB64url(auth), clientDataJSON: toB64url(cdj), signature: toB64url(rawToDer(raw)) };
    },
  };
}

interface Case {
  name: string;
  state: SecurityState;
  issued: StepUpIssued[];
  now: number;
  stepUp: unknown;
  expect: { result: string; method?: string; uv?: boolean; cloned?: string; state: SecurityState; issued: StepUpIssued[] };
}

const RFC_SECRET = base32Encode(enc.encode('12345678901234567890'));

async function generate() {
  const rpId = stepUpRpId('golden-install');
  const origin = 'nekko-app://desktop';
  const now = 1_790_000_000_000;
  const key = await authenticator(1);
  const fresh = await authenticator(2);
  const base: SecurityState = {
    ...emptySecurityState(rpId, [origin, 'http://localhost:5173']),
    enabled: true,
    credentials: [
      { id: key.id, publicKey: key.publicKey, counter: 5, name: 'YubiKey', kind: 'security-key', addedAt: now - 86_400_000 },
      { id: fresh.id, publicKey: fresh.publicKey, counter: 0, name: 'Touch ID', kind: 'passkey', addedAt: now - 3_600_000 },
    ],
    totp: { secret: RFC_SECRET, addedAt: now - 86_400_000 },
    recoveryHashes: [],
  };
  const C = toB64url(new Uint8Array(18).fill(7));
  const other = toB64url(new Uint8Array(18).fill(9));
  const live: StepUpIssued[] = [{ challenge: C, issuedAt: now - 1000, used: false }];
  const a = (o: Partial<Parameters<typeof key.assert>[0]> = {}, k = key) => k.assert({ rpId, challenge: C, origin, counter: 6, ...o });
  const step = totpStep(now);
  const secret = base32Decode(RFC_SECRET)!;
  const code = (d: number) => totpAt(secret, step + d);
  const withTotp = (t: Partial<NonNullable<SecurityState['totp']>>): SecurityState => ({ ...base, totp: { ...base.totp!, ...t } });
  const tampered = await a();
  tampered.signature = (await a({ counter: 7 })).signature;
  const cases: Array<Omit<Case, 'expect'>> = [
    { name: 'valid security key, user verified', state: base, issued: live, now, stepUp: await a() },
    { name: 'valid passkey with a zero counter, presence only', state: base, issued: live, now, stepUp: await a({ counter: 0, flags: 0x01 }, fresh) },
    { name: 'wrong challenge', state: base, issued: live, now, stepUp: await a({ challenge: other }) },
    { name: 'stale challenge', state: base, issued: [{ challenge: C, issuedAt: now - STEP_UP_CHALLENGE.ttlMs - 1, used: false }], now, stepUp: await a() },
    { name: 'replayed challenge', state: base, issued: [{ challenge: C, issuedAt: now - 1000, used: true }], now, stepUp: await a() },
    { name: 'counter not rising', state: base, issued: live, now, stepUp: await a({ counter: 5 }) },
    { name: 'signature over other data', state: base, issued: live, now, stepUp: tampered },
    { name: 'origin not allowed', state: base, issued: live, now, stepUp: await a({ origin: 'https://evil.example' }) },
    { name: 'another relying party', state: base, issued: live, now, stepUp: await a({ rpId: 'nekko-computer:other' }) },
    { name: 'no user presence', state: base, issued: live, now, stepUp: await a({ flags: 0x04 }) },
    { name: 'a registration, not an assertion', state: base, issued: live, now, stepUp: await a({ type: 'webauthn.create' }) },
    { name: 'unknown credential', state: base, issued: live, now, stepUp: { ...(await a()), credentialId: toB64url(new Uint8Array(16).fill(3)) } },
    { name: 'no step-up', state: base, issued: live, now, stepUp: null },
    { name: 'malformed step-up', state: base, issued: live, now, stepUp: { credentialId: 1 } },
    { name: 'totp now', state: base, issued: [], now, stepUp: { totp: await code(0) } },
    { name: 'totp one step behind', state: base, issued: [], now, stepUp: { totp: await code(-1) } },
    { name: 'totp one step ahead', state: base, issued: [], now, stepUp: { totp: await code(1) } },
    { name: 'totp two steps behind', state: base, issued: [], now, stepUp: { totp: await code(-2) } },
    { name: 'totp replayed', state: withTotp({ lastStep: step }), issued: [], now, stepUp: { totp: await code(0) } },
    { name: 'totp fifth wrong code locks a minute', state: withTotp({ wrong: 4 }), issued: [], now, stepUp: { totp: '000000' } },
    { name: 'totp while locked', state: withTotp({ lockedUntil: now + 1000, locks: 1 }), issued: [], now, stepUp: { totp: await code(0) } },
    { name: 'totp lock doubles', state: withTotp({ wrong: 4, locks: 1, lockedUntil: now - 1 }), issued: [], now, stepUp: { totp: 'abcdef' } },
    { name: 'totp after the lock clears the count', state: withTotp({ wrong: 2, locks: 1, lockedUntil: now - 1 }), issued: [], now, stepUp: { totp: await code(0) } },
    { name: 'totp without a totp method', state: { ...base, totp: null }, issued: [], now, stepUp: { totp: await code(0) } },
  ];
  const out: Case[] = [];
  for (const c of cases) {
    const r = await checkStepUp(c.state, c.issued, c.now, c.stepUp);
    const e: Case['expect'] = { result: r.result, state: r.state, issued: r.issued };
    if (r.method) e.method = r.method;
    if (r.uv !== undefined) e.uv = r.uv;
    if (r.cloned) e.cloned = r.cloned;
    out.push({ ...c, expect: e });
  }
  const codes = newRecoveryCodes();
  const totpVectors = [];
  for (const t of [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000]) {
    totpVectors.push({ secret: RFC_SECRET, step: totpStep(t * 1000), code: await totpAt(secret, totpStep(t * 1000)) });
  }
  return {
    about: 'Step-up verifier cases (SK-1). Written by packages/shared/src/step-up.golden.test.ts with UPDATE_GOLDEN=1; read by crates/nekko-remote/tests/golden.rs.',
    cases: out,
    totpVectors,
    recovery: { codes, hashes: await Promise.all(codes.map(hashRecoveryCode)) },
  };
}

describe('step-up golden', () => {
  it('writes or checks step-up.json', async () => {
    if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, `${JSON.stringify(await generate(), null, 1)}\n`);
    const golden = JSON.parse(readFileSync(file, 'utf8'));
    expect(golden.cases.length).toBeGreaterThan(20);
    for (const c of golden.cases as Case[]) {
      const r = await checkStepUp(c.state, c.issued, c.now, c.stepUp);
      expect({ result: r.result, method: r.method, uv: r.uv, cloned: r.cloned }, c.name).toEqual({
        result: c.expect.result,
        method: c.expect.method,
        uv: c.expect.uv,
        cloned: c.expect.cloned,
      });
      expect(JSON.parse(JSON.stringify(r.state)), c.name).toEqual(c.expect.state);
      expect(r.issued, c.name).toEqual(c.expect.issued);
    }
    const byName = Object.fromEntries((golden.cases as Case[]).map((c) => [c.name, c.expect.result]));
    expect(byName).toMatchObject({
      'valid security key, user verified': 'ok',
      'valid passkey with a zero counter, presence only': 'ok',
      'wrong challenge': 'step-up-invalid',
      'stale challenge': 'step-up-stale',
      'replayed challenge': 'step-up-replayed',
      'counter not rising': 'step-up-invalid',
      'no step-up': 'step-up-required',
      'totp now': 'ok',
      'totp two steps behind': 'step-up-invalid',
      'totp replayed': 'step-up-replayed',
      'totp while locked': 'step-up-invalid',
    });
    // RFC 6238 appendix B (SHA-1), last six digits.
    expect(golden.totpVectors.map((v: { code: string }) => v.code)).toEqual(['287082', '081804', '050471', '005924', '279037', '353130']);
  });
});

describe('step-up pieces', () => {
  it('flags a cloned credential and locks totp, doubling', async () => {
    const g = JSON.parse(readFileSync(file, 'utf8'));
    const find = (n: string) => (g.cases as Case[]).find((c) => c.name === n)!.expect;
    expect(find('counter not rising').state.credentials[0].cloned).toBe(true);
    expect(find('valid security key, user verified').state.credentials[0].counter).toBe(6);
    expect(find('totp fifth wrong code locks a minute').state.totp).toMatchObject({ wrong: 0, locks: 1 });
    const now = g.cases[0].now;
    expect(find('totp fifth wrong code locks a minute').state.totp?.lockedUntil).toBe(now + 60_000);
    expect(find('totp lock doubles').state.totp?.lockedUntil).toBe(now + 120_000);
  });

  it('round-trips DER signatures and base32', () => {
    const raw = new Uint8Array(64).map((_, i) => (i === 0 || i === 32 ? 0x80 : i));
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    const small = new Uint8Array(64).fill(0);
    small[31] = 1;
    small[63] = 2;
    expect(derToRaw(rawToDer(small))).toEqual(small);
    expect(derToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toBeNull();
    const b = enc.encode('hello world!');
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Decode('not base32!')).toBeNull();
  });

  it('uses each recovery code once, ignoring case and dashes', async () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    const state = { ...emptySecurityState('r', []), recoveryHashes: await Promise.all(codes.map(hashRecoveryCode)) };
    const after = await useRecoveryCode(state, codes[3].toUpperCase().replace('-', ' '));
    expect(after?.recoveryHashes).toHaveLength(9);
    expect(await useRecoveryCode(after!, codes[3])).toBeNull();
  });
});
