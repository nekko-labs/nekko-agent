import { describe, expect, it } from 'vitest';
import type { WebAuthnCeremonyRequest } from '@nekko-agent/shared';
import { ceremonyPage, runWebAuthnCeremony, validCeremonyRequest, type CeremonyCredentials } from './webauthnCeremony.js';

const bytes = (...b: number[]) => new Uint8Array(b).buffer;

const create: WebAuthnCeremonyRequest = {
  mode: 'create',
  rpId: 'localhost',
  rpName: 'Nekko Agent',
  userId: 'AQID',
  userName: 'nekko-agent@mac',
  userDisplayName: 'Nekko Agent on mac',
  challenge: 'BwcH',
  attachment: 'cross-platform',
  excludeCredentials: ['CAgI'],
  timeoutMs: 120_000,
};
const get: WebAuthnCeremonyRequest = { mode: 'get', rpId: 'localhost', challenge: 'BwcH', allowCredentials: ['AQ'], timeoutMs: 120_000 };

/** A fake authenticator that records what it was asked. */
function fake(answer: unknown, error?: { name: string; message: string }) {
  const asked: Array<{ publicKey: any }> = [];
  const creds: CeremonyCredentials = {
    create: async (o) => { asked.push(o as never); if (error) throw error; return answer; },
    get: async (o) => { asked.push(o as never); if (error) throw error; return answer; },
  };
  return { creds, asked };
}

describe('the WebAuthn ceremony', () => {
  it('registers with ES256, no attestation, the key kind asked, and returns base64url', async () => {
    const f = fake({ rawId: bytes(1, 2, 3), response: { clientDataJSON: bytes(0xfb, 0xff), attestationObject: bytes(9) } });
    const r = await runWebAuthnCeremony(create, f.creds);
    expect(r).toEqual({ ok: true, mode: 'create', rpId: 'localhost', id: 'AQID', clientDataJSON: '-_8', attestationObject: 'CQ' });
    const pk = f.asked[0].publicKey;
    expect(pk.rp).toEqual({ id: 'localhost', name: 'Nekko Agent' });
    expect(pk.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(pk.attestation).toBe('none');
    expect(pk.authenticatorSelection.authenticatorAttachment).toBe('cross-platform');
    expect([...new Uint8Array(pk.challenge)]).toEqual([7, 7, 7]);
    expect([...new Uint8Array(pk.excludeCredentials[0].id)]).toEqual([8, 8, 8]);
  });

  it('answers a step-up with the assertion’s four fields', async () => {
    const f = fake({ rawId: bytes(1), response: { authenticatorData: bytes(2), clientDataJSON: bytes(3), signature: bytes(4) } });
    const r = await runWebAuthnCeremony(get, f.creds);
    expect(r).toEqual({ ok: true, mode: 'get', rpId: 'localhost', credentialId: 'AQ', authenticatorData: 'Ag', clientDataJSON: 'Aw', signature: 'BA' });
    expect(f.asked[0].publicKey.rpId).toBe('localhost');
    expect(f.asked[0].publicKey.allowCredentials[0].type).toBe('public-key');
  });

  it('says what went wrong in plain words', async () => {
    expect(await runWebAuthnCeremony(get, fake(null, { name: 'NotAllowedError', message: 'x' }).creds)).toMatchObject({ ok: false, cancelled: true });
    expect(await runWebAuthnCeremony(create, fake(null, { name: 'InvalidStateError', message: 'x' }).creds)).toMatchObject({ ok: false, error: expect.stringContaining('already registered') });
    expect(await runWebAuthnCeremony(get, fake(null, { name: 'SecurityError', message: 'x' }).creds)).toMatchObject({ ok: false, error: expect.stringContaining('https') });
    expect(await runWebAuthnCeremony(get, fake(null).creds)).toMatchObject({ ok: false, cancelled: true });
  });

  it('is self-contained, so main can run its source in the ceremony window', async () => {
    const standalone = new Function(`return (${runWebAuthnCeremony.toString()})`)() as typeof runWebAuthnCeremony;
    const f = fake({ rawId: bytes(1), response: { authenticatorData: bytes(2), clientDataJSON: bytes(3), signature: bytes(4) } });
    expect(await standalone(get, f.creds)).toMatchObject({ ok: true, credentialId: 'AQ' });
  });

  it('accepts only well-formed requests from the renderer', () => {
    expect(validCeremonyRequest(create)).toBe(true);
    expect(validCeremonyRequest(get)).toBe(true);
    expect(validCeremonyRequest({ ...get, challenge: 'not base64url!' })).toBe(false);
    expect(validCeremonyRequest({ ...get, rpId: 'evil.example/x' })).toBe(false);
    expect(validCeremonyRequest({ ...get, timeoutMs: 0 })).toBe(false);
    expect(validCeremonyRequest({ ...create, attachment: 'usb' })).toBe(false);
    expect(validCeremonyRequest({ ...get, allowCredentials: new Array(65).fill('AQ') })).toBe(false);
    expect(validCeremonyRequest({ mode: 'other' })).toBe(false);
    expect(validCeremonyRequest(null)).toBe(false);
  });

  it('shows a static page that says what to do, with the note, escaped', () => {
    const page = ceremonyPage('create', 'platform', 'Note <b>');
    expect(page).toContain('Set up a passkey on this computer');
    expect(page).toContain('Note &lt;b&gt;');
    expect(page).not.toContain('<script');
    expect(ceremonyPage('get', undefined, '')).toContain('Confirm with your security key');
  });
});
