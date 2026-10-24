import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SECURITY_KEY_UNTESTED_NOTE, type SecurityStatus } from '@nekko-agent/shared';
import { SecuritySettingsView } from './SecuritySettings.js';
import { StepUpSheetView, usableKeys } from './StepUpSheet.js';

vi.mock('../../store.js', () => ({ useStore: Object.assign(() => undefined, { getState: () => ({ pushToast: vi.fn() }) }) }));

const NOW = 1_790_000_000_000;
const status = (o: Partial<SecurityStatus> = {}): SecurityStatus => ({
  available: true,
  enabled: false,
  methods: [],
  totp: null,
  recoveryLeft: 0,
  minMethods: 2,
  coverMs: 300_000,
  covered: {},
  ...o,
});
const key = (id: string, name: string, extra = {}) => ({ id, name, kind: 'security-key' as const, addedAt: NOW - 86_400_000, cloned: false, ...extra });

const html = (o: Partial<Parameters<typeof SecuritySettingsView>[0]> = {}) =>
  renderToStaticMarkup(
    <SecuritySettingsView
      status={status()}
      codes={null}
      totp={null}
      pairedPhones={0}
      webAuthnBlocked={null}
      passkeys
      rpId="localhost"
      now={NOW}
      onAddKey={vi.fn()}
      onTotpBegin={vi.fn()}
      onTotpConfirm={vi.fn()}
      onTotpCancel={vi.fn()}
      onCodesSaved={vi.fn()}
      onEnable={vi.fn()}
      onDisable={vi.fn()}
      onRemove={vi.fn()}
      onNewCodes={vi.fn()}
      onCopyCodes={vi.fn()}
      {...o}
    />,
  );

/** The unescaped text of the markup, as the owner reads it. */
const text = (out: string) => out.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('Settings → Security', () => {
  it('starts empty, with the two-methods rule and the untested-hardware note linking to the issues', () => {
    const out = html();
    expect(out).toContain('Nothing registered yet.');
    expect(out).toContain('Add 2 methods first');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Turn on<\/button>/);
    expect(text(out)).toContain(SECURITY_KEY_UNTESTED_NOTE);
    expect(out).toContain('href="https://github.com/nekko-labs/nekko-agent/issues/new"');
    expect(out).toContain('Add passkey on this computer');
    expect(out).toContain('Set up a one-time code app');
  });

  it('lists each method with when it was added and used, and flags a possibly cloned key', () => {
    const out = html({ status: status({ methods: [key('a', 'YubiKey 5C', { lastUsedAt: NOW - 1000 }), key('b', 'Titan', { cloned: true })], totp: { addedAt: NOW - 3 * 86_400_000 }, recoveryLeft: 9 }) });
    expect(out).toContain('YubiKey 5C');
    expect(out).toContain('added yesterday · used today');
    expect((out.match(/possibly cloned/g) ?? []).length).toBe(1);
    expect(out).toContain('One-time code app');
    expect(out).toContain('9 recovery codes left.');
    expect(out).toMatch(/<button[^>]*>Turn on<\/button>/);
    expect(out).not.toMatch(/disabled=""[^>]*>Turn on/);
  });

  it('warns, not refuses, when the second method is a code app and phones are paired', () => {
    const out = html({ status: status({ methods: [key('a', 'YubiKey')], totp: { addedAt: 1 } }), pairedPhones: 1 });
    expect(out).toContain('If it is on a phone you paired');
    expect(out).not.toMatch(/disabled=""[^>]*>Turn on/);
  });

  it('offers Turn off when on, and shows recovery codes once with a way to save them', () => {
    const out = html({ status: status({ enabled: true, methods: [key('a', 'A'), key('b', 'B')], recoveryLeft: 10 }), codes: ['abcde-fghij', 'klmno-pqrst'] });
    expect(out).toContain('Step-up on');
    expect(out).toContain('Turn off…');
    expect(out).toContain('Save these recovery codes now');
    expect(out).toContain('abcde-fghij');
    expect(out).toContain('I saved them');
  });

  it('shows the code app’s QR and asks for its first code', () => {
    const out = html({ totp: { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x', account: 'mac', qr: 'data:image/png;base64,AA' } });
    expect(out).toContain('alt="One-time code QR"');
    expect(out).toContain('JBSWY3DPEHPK3PXP');
    expect(out).toContain('aria-label="Code from the app"');
  });

  it('says step-up needs https on a Local Web UI that is not a secure context, and still offers codes', () => {
    const out = html({ webAuthnBlocked: 'Security keys and passkeys need https here.', passkeys: false });
    expect(out).toContain('need https here');
    expect(out).toMatch(/disabled=""[^>]*>Add security key/);
    expect(out).not.toContain('Add passkey on this computer');
    expect(out).toContain('On Linux, use a security key');
    expect(out).not.toMatch(/disabled=""[^>]*>Set up a one-time code app/);
  });

  it('says a damaged security.json refuses every guarded action', () => {
    expect(html({ status: status({ enabled: true, damaged: true }) })).toContain('security.json can’t be read');
  });
});

describe('the step-up sheet', () => {
  const sheet = (o: Partial<Parameters<typeof StepUpSheetView>[0]> = {}) =>
    renderToStaticMarkup(
      <StepUpSheetView
        title="Confirm with your security key"
        what="Pair a phone or sign out all phones"
        message="Confirm with your security key or a code to do this."
        keyNames={['YubiKey']}
        blocked={null}
        totp
        recovery={false}
        phase="idle"
        entry={null}
        code=""
        error={null}
        answered={null}
        onUseKey={vi.fn()}
        onEntry={vi.fn()}
        onCode={vi.fn()}
        onSubmitCode={vi.fn()}
        onCancel={vi.fn()}
        {...o}
      />,
    );

  it('names the action, offers the key and a code, and carries the note', () => {
    const out = sheet();
    expect(out).toContain('Pair a phone or sign out all phones');
    expect(out).toContain('Use security key');
    expect(out).toContain('Use a code');
    expect(out).not.toContain('Use a recovery code');
    expect(out).toContain('Cancel');
    expect(text(out)).toContain(SECURITY_KEY_UNTESTED_NOTE);
  });

  it('names the key that answered', () => {
    expect(sheet({ phase: 'done', answered: 'YubiKey' })).toContain('Confirmed with YubiKey.');
  });

  it('offers a recovery code only to turn step-up off or remove a method', () => {
    const out = sheet({ recovery: true, entry: 'recovery', code: 'abc' });
    expect(out).toContain('aria-label="Recovery code"');
    expect(sheet({ recovery: true })).toContain('Use a recovery code');
  });

  it('falls back to a code where keys can’t work', () => {
    const out = sheet({ blocked: 'Security keys and passkeys need https here.' });
    expect(out).not.toContain('Use security key');
    expect(out).toContain('need https here');
    expect(out).toContain('Use a code');
    expect(sheet({ keyNames: [], keysElsewhere: true })).toContain('registered from another address');
  });

  it('asks only keys registered for this page, never the one being removed', () => {
    const c = { challenge: 'c', expiresAt: 0, required: true, methods: [], totp: false, recovery: false, credentials: [
      { id: 'a', name: 'A', kind: 'security-key' as const, rpId: 'localhost' },
      { id: 'b', name: 'B', kind: 'security-key' as const, rpId: 'box.example' },
      { id: 'c', name: 'C', kind: 'passkey' as const, rpId: 'localhost' },
      { id: 'd', name: 'Phone', kind: 'passkey' as const },
    ] };
    expect(usableKeys(c, 'localhost').map((k) => k.id)).toEqual(['a', 'c']);
    expect(usableKeys(c, 'localhost', 'a').map((k) => k.id)).toEqual(['c']);
    expect(usableKeys(null, 'localhost')).toEqual([]);
  });
});
