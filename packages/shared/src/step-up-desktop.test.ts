import { describe, expect, it } from 'vitest';
import { IpcChannels } from './ipc.js';
import { PHONE_CHANNELS, phoneChannelAllowed } from './phone-access.js';
import { checkStepUp, emptySecurityState, rawToDer, toB64, toB64url, type StepUpIssued } from './step-up.js';
import {
  SECURITY_DESKTOP_CHANNELS,
  STEP_UP_ACTION_LABELS,
  STEP_UP_DESKTOP_METHODS,
  desktopStepUpAction,
  remoteStoppedBanner,
  safetyExitNotice,
  stepUpEnableBlocker,
  stepUpEnableWarning,
  stepUpRefusalOf,
  type SecurityStatus,
} from './step-up-desktop.js';
import {
  FOLDABLE_UNTESTED_NOTE,
  SECURITY_KEY_UNTESTED_NOTE,
  UNTESTED_HARDWARE_ISSUES_URL,
  UNTESTED_HARDWARE_NOTES,
  splitUntestedNote,
} from './untested-hardware-notes.js';

describe('Settings → Security stays off the phone', () => {
  it('keeps every desktop security channel, remote:enable and remote:setAccess out of PHONE_CHANNELS', () => {
    const phone = new Set<string>(PHONE_CHANNELS);
    for (const c of Object.values(SECURITY_DESKTOP_CHANNELS)) {
      // A phone fetches its own challenge, answered by the daemon's phone gate (SK-2).
      if (c === 'security:challenge') continue;
      expect(phone.has(c), c).toBe(false);
      expect(phoneChannelAllowed(c), c).toBe(false);
    }
    for (const c of ['remote:enable', 'remote:attach', 'remote:setAccess', 'remote:pair', 'remote:rotate', 'providers:save']) {
      expect(phone.has(c), c).toBe(false);
    }
  });

  it('names the same channels in IpcChannels', () => {
    const ipc = new Set<string>(Object.values(IpcChannels));
    for (const c of Object.values(SECURITY_DESKTOP_CHANNELS)) expect(ipc.has(c), c).toBe(true);
  });
});

describe('desktop step-up actions', () => {
  it('maps each guarded channel to the class one confirmation covers', () => {
    expect(desktopStepUpAction('remote:enable')).toBe('remoteAccess');
    expect(desktopStepUpAction('remote:attach')).toBe('remoteAccess');
    expect(desktopStepUpAction('remote:pair')).toBe('pairing');
    expect(desktopStepUpAction('remote:rotate')).toBe('pairing');
    expect(desktopStepUpAction('remote:setAccess')).toBe('phoneAccess');
    expect(desktopStepUpAction('providers:save')).toBe('providerKeys');
    for (const c of STEP_UP_DESKTOP_METHODS.channels) expect(desktopStepUpAction(c)).toBe('securityMethods');
    // Turning step-up off carries its own proof; the safety exits are never guarded.
    for (const c of ['security:disable', 'security:removeMethod', 'remote:disable', 'remote:stop', 'app:quit', 'settings:get']) {
      expect(desktopStepUpAction(c), c).toBeNull();
    }
    for (const a of ['remoteAccess', 'pairing', 'phoneAccess', 'providerKeys', 'securityMethods', 'stepUpOff'] as const) {
      expect(STEP_UP_ACTION_LABELS[a]).toBeTruthy();
    }
  });

  it('reads the daemon’s refusal out of an error', () => {
    const r = stepUpRefusalOf(new Error('Step-up needed (step-up-required) [remoteAccess]: Confirm with your security key or a code to do this.'));
    expect(r).toEqual({ code: 'step-up-required', action: 'remoteAccess', message: 'Confirm with your security key or a code to do this.' });
    expect(stepUpRefusalOf('Error: Step-up needed (step-up-replayed) [pairing]: x')?.code).toBe('step-up-replayed');
    // A phone's refusal has no action class; the sentence comes from STEP_UP_MESSAGES.
    expect(stepUpRefusalOf('Not allowed from a paired phone (step-up-stale)')).toMatchObject({ action: null, message: 'That confirmation took too long. Try again.' });
    expect(stepUpRefusalOf(new Error('remote:enable: relay unreachable'))).toBeNull();
    expect(stepUpRefusalOf(undefined)).toBeNull();
  });
});

describe('two methods', () => {
  const status = (methods: Array<'security-key' | 'passkey'>, totp: boolean): SecurityStatus => ({
    available: true,
    enabled: false,
    methods: methods.map((kind, i) => ({ id: `k${i}`, name: `Key ${i}`, kind, addedAt: 1, cloned: false })),
    totp: totp ? { addedAt: 1 } : null,
    recoveryLeft: 10,
    minMethods: 2,
    coverMs: 300_000,
    covered: {},
  });

  it('cannot be turned on with fewer than two methods', () => {
    expect(stepUpEnableBlocker(status([], false))).toContain('Add 2 methods first');
    expect(stepUpEnableBlocker(status(['security-key'], false))).toContain('Add one more method first');
    expect(stepUpEnableBlocker(status(['security-key'], true))).toBeNull();
    expect(stepUpEnableBlocker({ ...status(['security-key', 'security-key'], false), available: false })).toContain('data folder');
  });

  it('warns, not refuses, when the second method is a code app with phones paired', () => {
    expect(stepUpEnableWarning(status(['security-key'], true), 1)).toContain('one-time code app');
    expect(stepUpEnableWarning(status(['passkey'], true), 2)).toContain('add a security key');
    expect(stepUpEnableWarning(status(['security-key'], true), 0)).toBeNull();
    expect(stepUpEnableWarning(status(['security-key', 'security-key'], true), 1)).toBeNull();
    expect(stepUpEnableWarning(status(['security-key', 'passkey'], false), 1)).toBeNull();
  });
});

describe('safety exits on the desktop', () => {
  const t = () => '14:02';
  it('says which phone did what, and when', () => {
    expect(safetyExitNotice({ channel: 'remote:stop', deviceId: 'p', name: 'Philip’s iPhone', at: 1 }, t)?.body).toBe(
      'Remote access was stopped from Philip’s iPhone at 14:02. Turn it on again from Settings → Phone pairing.',
    );
    expect(safetyExitNotice({ channel: 'device:signOut', deviceId: 'p', name: null, at: 1 }, t)?.body).toContain('A paired phone signed out');
    expect(safetyExitNotice({ channel: 'app:quit', deviceId: 'p', name: 'Pixel', at: 1 }, t)?.title).toBe('Nekko Agent is quitting');
    expect(safetyExitNotice({ channel: 'remote:other' as never, deviceId: 'p', at: 1 }, t)).toBeNull();
  });

  it('writes the Remote access banner as the spec does', () => {
    expect(remoteStoppedBanner({ name: 'Philip’s iPhone', at: 1 }, t)).toBe('Remote access was stopped from Philip’s iPhone at 14:02. Turn it on again from here.');
    expect(remoteStoppedBanner({ at: 1 }, t)).toContain('from a paired phone at');
  });
});

describe('untested hardware notes', () => {
  it('keeps the owner’s words exactly', () => {
    expect(SECURITY_KEY_UNTESTED_NOTE).toBe(
      'The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please let us know \u{1F64F}',
    );
    expect(FOLDABLE_UNTESTED_NOTE).toBe(
      'The Devs don’t have a foldable phone to test this one, so we tried our best without one! If you see any issues, please let us know \u{1F64F}',
    );
    expect(UNTESTED_HARDWARE_ISSUES_URL).toBe('https://github.com/nekko-labs/nekko-agent/issues/new');
    expect(UNTESTED_HARDWARE_NOTES.securityKey).toBe(SECURITY_KEY_UNTESTED_NOTE);
  });

  it('splits a note around “let us know”', () => {
    const s = splitUntestedNote(SECURITY_KEY_UNTESTED_NOTE);
    expect(s.link).toBe('let us know');
    expect(s.before + s.link + s.after).toBe(SECURITY_KEY_UNTESTED_NOTE);
    expect(s.after).toBe(' \u{1F64F}');
    expect(splitUntestedNote('no link')).toEqual({ before: 'no link', link: '', after: '' });
  });
});

describe('a credential bound to its own relying-party id', () => {
  const enc = new TextEncoder();
  const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

  it('is checked against its rpId, and one without against the computer’s', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = toB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const id = toB64url(new Uint8Array(16).fill(1));
    const challenge = toB64url(new Uint8Array(18).fill(7));
    const origin = 'http://localhost:1440';
    const assert = async (rpId: string) => {
      const auth = new Uint8Array(37);
      auth.set(await sha256(enc.encode(rpId)), 0);
      auth[32] = 0x05;
      new DataView(auth.buffer).setUint32(33, 1);
      const cdj = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array([...auth, ...(await sha256(cdj))])));
      return { credentialId: id, authenticatorData: toB64url(auth), clientDataJSON: toB64url(cdj), signature: toB64url(rawToDer(raw)) };
    };
    const state = (rpId?: string) => ({
      ...emptySecurityState('nekko-computer:x', [origin]),
      enabled: true,
      credentials: [{ id, publicKey, counter: 0, name: 'Key', kind: 'security-key' as const, addedAt: 1, ...(rpId ? { rpId } : {}) }],
    });
    const book = (): StepUpIssued[] => [{ challenge, issuedAt: 0, used: false }];
    expect((await checkStepUp(state('localhost'), book(), 1, await assert('localhost'))).result).toBe('ok');
    expect((await checkStepUp(state('localhost'), book(), 1, await assert('nekko-computer:x'))).why).toBe('rpId');
    expect((await checkStepUp(state(), book(), 1, await assert('nekko-computer:x'))).result).toBe('ok');
  });
});
