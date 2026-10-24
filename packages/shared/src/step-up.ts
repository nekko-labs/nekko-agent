/**
 * Step-up: a second factor the owner holds (a FIDO2 security key, a platform
 * passkey or a one-time code), asked for on top of today's checks before a
 * short, fixed list of guarded actions (SK-1, spec
 * `spec/platform/hardware-keys-step-up-and-remote-sign-out.md`, decision 0018).
 *
 * The computer is the relying party: it issues the challenge, holds the
 * credentials' public keys and counters in `security.json`, and verifies
 * every assertion itself. The daemon's verifier is
 * `crates/nekko-remote/src/step_up.rs`; this file is its TypeScript twin and
 * the source of the constants both read. The two are held equal by the golden
 * fixture `crates/nekko-remote/tests/golden/step-up.json` (real ES256
 * assertions from a software authenticator, written by `step-up.test.ts`).
 *
 * Uses WebCrypto only (browser and Node 20+), like `e2e.ts`.
 */

import { PHONE_MODE_PROOF } from './phone-access.js';

// ---- the guarded actions ----

/**
 * A guarded action from a phone: raising a chat's mode or the default mode
 * (`PHONE_MODE_PROOF`: `session:setOptions` setting `mode`, `settings:update`
 * setting `defaultChatMode`, to a more permissive mode). The computer checks
 * the Change proof first, then the step-up, when `security.json` has
 * `enabled: true`. Every other phone channel keeps today's rules.
 */
export const STEP_UP_PHONE_GUARDED = {
  modeRaise: { channels: PHONE_MODE_PROOF.channels, keys: { 'session:setOptions': 'mode', 'settings:update': 'defaultChatMode' } },
} as const;

/**
 * Guarded actions on the desktop (and the Local Web UI), checked in the main
 * process before the call runs (SK-4 wires them). None of these is a phone
 * channel: every `remote:`, `providers:save`/`remove` and `security:register*`
 * channel stays out of `PHONE_CHANNELS`.
 */
export const STEP_UP_DESKTOP_GUARDED = {
  /** Raise a chat's mode, or the default mode (the same rule as the phone's). */
  modeRaise: ['session:setOptions', 'settings:update'],
  /** Turn remote access on, change the relay or the connection. */
  remoteAccess: ['remote:enable', 'remote:attach'],
  /** Pair a device, rotate the secret (*Sign out all phones*). */
  pairing: ['remote:pair', 'remote:rotate'],
  /** Change what a phone may do (Read / Change switches, *Lock phones*). */
  phoneAccess: ['remote:setAccess'],
  /** Add, show or change a provider key or account. */
  providerKeys: ['providers:save', 'providers:remove', 'providers:importCliAuth', 'providers:revealKey'],
  /** Turn step-up off or remove a method: a *different* method, or a recovery code. */
  stepUpOff: ['security:disable', 'security:removeMethod'],
} as const;

export type StepUpDesktopAction = keyof typeof STEP_UP_DESKTOP_GUARDED;

/** Never guarded: a safety exit must never be harder than the attack (decision 0018). */
export const STEP_UP_NEVER_GUARDED = ['app:quit', 'device:signOut', 'remote:stop'] as const;

// ---- the challenge ----

/**
 * `security:challenge` (read class from a phone): a fresh challenge for one
 * step-up, 18 random bytes as unpadded base64url, single use, refused
 * `step-up-stale` after `ttlMs`. The reply also says whether step-up is on
 * and which kinds of method exist, so the phone can show the right sheet,
 * and nothing else about them.
 */
export const STEP_UP_CHALLENGE = { channel: 'security:challenge', bytes: 18, ttlMs: 2 * 60 * 1000 } as const;

/** One step-up covers the same class of action on that surface for this long (as the Change signer's window). */
export const STEP_UP_COVER_MS = 5 * 60 * 1000;

/** WebAuthn's assertion type in `clientDataJSON`. */
export const STEP_UP_CLIENT_TYPE = 'webauthn.get';

/** The relying-party id of a computer: per computer, so a credential is useless on another. */
export function stepUpRpId(installId: string): string {
  return `nekko-computer:${installId}`;
}

/** What `security:challenge` answers. */
export interface StepUpChallengeReply {
  challenge: string;
  expiresAt: number;
  /** Whether a guarded action needs a step-up now. */
  required: boolean;
  /** The kinds of method registered (never their ids or names). */
  methods: Array<SecurityCredentialKind | 'totp'>;
}

/** A challenge the computer issued, as its book keeps it. */
export interface StepUpIssued {
  challenge: string;
  issuedAt: number;
  used: boolean;
}

// ---- the payload ----

/** A FIDO2 assertion, every field unpadded base64url as WebAuthn's JSON form gives it. */
export interface StepUpAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/**
 * What a guarded phone request carries beside `proof` (`{ type:'req', id,
 * channel, args, proof, stepUp }`), inside the sealed frame.
 */
export type StepUpProof = StepUpAssertion | { totp: string };

// ---- refusals ----

/** The step-up refusals (also in `PhoneAccessCode`). */
export type StepUpCode = 'step-up-required' | 'step-up-invalid' | 'step-up-stale' | 'step-up-replayed';

/** The plain sentence a phone or the desktop shows for each refusal. */
export const STEP_UP_MESSAGES: Record<StepUpCode | 'quit-disabled', string> = {
  'step-up-required': 'Confirm with your security key or a code to do this.',
  'step-up-invalid': 'That key or code was not accepted. Try again.',
  'step-up-stale': 'That confirmation took too long. Try again.',
  'step-up-replayed': 'That confirmation was already used. Try again.',
  'quit-disabled': 'Quitting from a phone is turned off on the computer (Settings → Remote access).',
};

// ---- security.json ----

export type SecurityCredentialKind = 'security-key' | 'passkey';

/** A registered FIDO2 credential. */
export interface SecurityCredential {
  /** The credential id, unpadded base64url. */
  id: string;
  /** Base64 of the 65-byte X9.63 uncompressed P-256 point (ES256 only). */
  publicKey: string;
  /** The signature counter last seen. */
  counter: number;
  name: string;
  kind: SecurityCredentialKind;
  addedAt: number;
  lastUsedAt?: number;
  /** Set when an assertion's counter did not rise: shown as *possibly cloned*. */
  cloned?: boolean;
}

/** The TOTP method and its rate limit, per computer. */
export interface SecurityTotp {
  /** RFC 4648 base32, no padding. */
  secret: string;
  addedAt: number;
  lastUsedAt?: number;
  /** The last accepted time step: a code for it or an earlier one is a replay. */
  lastStep?: number;
  /** Wrong codes since the last lock or success. */
  wrong?: number;
  lockedUntil?: number;
  /** Locks so far: each one doubles the next. */
  locks?: number;
}

/** `security.json`, beside `remote.json`, mode 600. Never leaves the computer. */
export interface SecurityState {
  version: 1;
  enabled: boolean;
  rpId: string;
  /** The `clientDataJSON.origin` values accepted (the desktop's app origin, the Local Web UI's, the phones'). */
  origins: string[];
  credentials: SecurityCredential[];
  totp: SecurityTotp | null;
  /** Hex SHA-256 of each unused recovery code (`hashRecoveryCode`). */
  recoveryHashes: string[];
}

export function emptySecurityState(rpId: string, origins: string[]): SecurityState {
  return { version: 1, enabled: false, rpId, origins: [...origins], credentials: [], totp: null, recoveryHashes: [] };
}

/** Step-up can be turned on only with at least this many methods (keys and TOTP; recovery codes do not count). */
export const STEP_UP_MIN_METHODS = 2;

export function stepUpMethodCount(state: SecurityState): number {
  return state.credentials.length + (state.totp ? 1 : 0);
}

/** The kinds of method a phone may learn exist. */
export function stepUpMethodKinds(state: SecurityState): Array<SecurityCredentialKind | 'totp'> {
  const kinds = new Set<SecurityCredentialKind | 'totp'>(state.credentials.map((c) => c.kind));
  if (state.totp) kinds.add('totp');
  return [...kinds].sort();
}

// ---- TOTP ----

/** RFC 6238, SHA-1 for authenticator-app compatibility; 5 wrong codes, then a minute, doubling. */
export const STEP_UP_TOTP = { periodS: 30, digits: 6, window: 1, algorithm: 'SHA-1', maxWrong: 5, lockMs: 60 * 1000 } as const;

/** Ten single-use recovery codes, shown once. */
export const STEP_UP_RECOVERY = { count: 10, length: 10 } as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = BASE32.indexOf(c);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The code for one time step (HOTP, RFC 4226, over the step). */
export async function totpAt(secret: Uint8Array, step: number): Promise<string> {
  const msg = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = n % 256;
    n = Math.floor(n / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** STEP_UP_TOTP.digits).padStart(STEP_UP_TOTP.digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_UP_TOTP.periodS);
}

// ---- recovery codes ----

function normalizeRecovery(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Hex SHA-256 of a recovery code, ignoring case, spaces and dashes. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeRecovery(code))));
  return hex(digest);
}

/** New recovery codes (`xxxxx-xxxxx`, base32 letters), from `random(n)` bytes. */
export function newRecoveryCodes(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string[] {
  return Array.from({ length: STEP_UP_RECOVERY.count }, () => {
    const s = base32Encode(random(7)).slice(0, STEP_UP_RECOVERY.length).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Use a recovery code: the state without its hash, or `null` when it is not (or no longer) one. */
export async function useRecoveryCode(state: SecurityState, code: string): Promise<SecurityState | null> {
  const h = await hashRecoveryCode(code);
  if (!state.recoveryHashes.includes(h)) return null;
  return { ...state, recoveryHashes: state.recoveryHashes.filter((x) => x !== h) };
}

// ---- encodings ----

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Base64 or base64url, padded or not; `null` when it is neither. */
export function fromB64url(text: string): Uint8Array | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  const std = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (std.length % 4 === 1) return null;
  try {
    const s = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A DER ECDSA signature (WebAuthn's form) as raw 64-byte r||s, or `null`. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  let i = 0;
  const byte = () => (i < der.length ? der[i++] : -1);
  if (byte() !== 0x30) return null;
  const total = byte();
  if (total < 0 || total & 0x80 || total !== der.length - 2) return null;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (byte() !== 0x02) return null;
    const len = byte();
    if (len < 1 || len > 33 || i + len > der.length) return null;
    let int = der.subarray(i, i + len);
    i += len;
    if (int.length === 33) {
      if (int[0] !== 0) return null;
      int = int.subarray(1);
    }
    out.set(int, part * 32 + (32 - int.length));
  }
  return i === der.length ? out : null;
}

/** Raw r||s as DER (what an authenticator sends). */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let s = 0;
    while (s < b.length - 1 && b[s] === 0) s++;
    const v = b.subarray(s);
    return v[0] & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32, 64))];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---- the verifier ----

/** What one step-up check did. `state` and `issued` are the updated copies to save, whatever the outcome. */
export interface StepUpOutcome {
  /** `ok`, or the refusal. */
  result: 'ok' | StepUpCode;
  method?: 'fido2' | 'totp';
  /** Why, in a few words (logs and tests; the wire carries the code). */
  why?: string;
  /** FIDO2: the user-verified flag of the accepted assertion. */
  uv?: boolean;
  /** FIDO2: the id of a credential just flagged *possibly cloned*. */
  cloned?: string;
  state: SecurityState;
  issued: StepUpIssued[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Check one step-up against `state` (security.json) and the challenges
 * issued to this caller. `issued` entries used or older than the TTL are
 * kept (the caller prunes them), so a replay or a late answer is named.
 * Step-up being off is the caller's decision, not this function's.
 */
export async function checkStepUp(state: SecurityState, issued: StepUpIssued[], now: number, stepUp: unknown): Promise<StepUpOutcome> {
  const st: SecurityState = structuredClone(state);
  const book: StepUpIssued[] = issued.map((x) => ({ ...x }));
  const out = (result: StepUpOutcome['result'], rest: Partial<StepUpOutcome> = {}): StepUpOutcome => ({ result, ...rest, state: st, issued: book });
  if (stepUp == null) return out('step-up-required');
  if (!isObj(stepUp)) return out('step-up-invalid', { why: 'shape' });
  if ('totp' in stepUp) return checkTotp(st, now, stepUp.totp, out);
  const f = ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature'] as const;
  if (!f.every((k) => typeof stepUp[k] === 'string')) return out('step-up-invalid', { why: 'shape' });
  const [idB, authData, cdj, sigDer] = f.map((k) => fromB64url(stepUp[k] as string));
  if (!idB || !authData || !cdj || !sigDer) return out('step-up-invalid', { why: 'encoding' });
  const cred = st.credentials.find((c) => {
    const b = fromB64url(c.id);
    return b !== null && equal(b, idB);
  });
  if (!cred) return out('step-up-invalid', { why: 'credential' });
  let client: unknown;
  try {
    client = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cdj));
  } catch {
    return out('step-up-invalid', { why: 'clientData' });
  }
  if (!isObj(client) || client.type !== STEP_UP_CLIENT_TYPE || typeof client.challenge !== 'string') {
    return out('step-up-invalid', { why: 'clientData' });
  }
  const said = fromB64url(client.challenge);
  const entry = said && book.find((x) => {
    const b = fromB64url(x.challenge);
    return b !== null && equal(b, said);
  });
  if (!entry) return out('step-up-invalid', { why: 'challenge' });
  if (entry.used) return out('step-up-replayed');
  // Single use: any answer to a live challenge spends it, good or bad.
  entry.used = true;
  if (now - entry.issuedAt > STEP_UP_CHALLENGE.ttlMs) return out('step-up-stale');
  if (typeof client.origin !== 'string' || !st.origins.includes(client.origin)) return out('step-up-invalid', { why: 'origin' });
  if (authData.length < 37) return out('step-up-invalid', { why: 'authenticatorData' });
  if (!equal(authData.subarray(0, 32), await sha256(new TextEncoder().encode(st.rpId)))) return out('step-up-invalid', { why: 'rpId' });
  const flags = authData[32];
  if (!(flags & 0x01)) return out('step-up-invalid', { why: 'user presence' });
  const raw = derToRaw(sigDer);
  const keyBytes = fromB64url(cred.publicKey);
  if (!raw || !keyBytes || keyBytes.length !== 65 || keyBytes[0] !== 4) return out('step-up-invalid', { why: 'signature' });
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(await sha256(cdj), authData.length);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw as BufferSource, signed);
  } catch {
    ok = false;
  }
  if (!ok) return out('step-up-invalid', { why: 'signature' });
  const counter = ((authData[33] << 24) >>> 0) + (authData[34] << 16) + (authData[35] << 8) + authData[36];
  if (!(counter === 0 && cred.counter === 0) && counter <= cred.counter) {
    cred.cloned = true;
    return out('step-up-invalid', { why: 'counter', cloned: cred.id });
  }
  cred.counter = counter;
  cred.lastUsedAt = now;
  return out('ok', { method: 'fido2', uv: (flags & 0x04) !== 0 });
}

async function checkTotp(
  st: SecurityState,
  now: number,
  code: unknown,
  out: (result: StepUpOutcome['result'], rest?: Partial<StepUpOutcome>) => StepUpOutcome,
): Promise<StepUpOutcome> {
  const t = st.totp;
  if (!t) return out('step-up-invalid', { why: 'no totp' });
  if (t.lockedUntil !== undefined && now < t.lockedUntil) return out('step-up-invalid', { why: 'locked' });
  const secret = base32Decode(t.secret);
  if (!secret || secret.length === 0) return out('step-up-invalid', { why: 'secret' });
  const step = totpStep(now);
  let matched: number | null = null;
  if (typeof code === 'string' && /^[0-9]{6}$/.test(code)) {
    for (let d = -STEP_UP_TOTP.window; d <= STEP_UP_TOTP.window; d++) {
      if ((await totpAt(secret, step + d)) === code) {
        matched = step + d;
        break;
      }
    }
  }
  if (matched !== null) {
    if (t.lastStep !== undefined && matched <= t.lastStep) return out('step-up-replayed');
    t.lastStep = matched;
    t.lastUsedAt = now;
    delete t.wrong;
    delete t.lockedUntil;
    delete t.locks;
    return out('ok', { method: 'totp' });
  }
  t.wrong = (t.wrong ?? 0) + 1;
  if (t.wrong >= STEP_UP_TOTP.maxWrong) {
    t.lockedUntil = now + STEP_UP_TOTP.lockMs * 2 ** (t.locks ?? 0);
    t.locks = (t.locks ?? 0) + 1;
    t.wrong = 0;
  }
  return out('step-up-invalid', { why: 'code' });
}

/** The constants as data, for the daemon (`phone-access.json`'s `stepUp`). */
export function stepUpPolicy() {
  return {
    challenge: { ...STEP_UP_CHALLENGE },
    coverMs: STEP_UP_COVER_MS,
    clientType: STEP_UP_CLIENT_TYPE,
    totp: { ...STEP_UP_TOTP },
    recovery: { ...STEP_UP_RECOVERY },
    minMethods: STEP_UP_MIN_METHODS,
    phoneGuarded: { channels: [...STEP_UP_PHONE_GUARDED.modeRaise.channels] },
    desktopGuarded: Object.fromEntries(Object.entries(STEP_UP_DESKTOP_GUARDED).map(([k, v]) => [k, [...v]])),
    neverGuarded: [...STEP_UP_NEVER_GUARDED],
  };
}
