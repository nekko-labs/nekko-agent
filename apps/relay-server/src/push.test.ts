import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, createVerify } from 'node:crypto';
import { activityPayload, alertPayload, dismissPayload, makeApnsJwt, makeFcmAssertion } from './push.js';

describe('alert and dismissal payloads', () => {
  it('carry the kind and the opaque chat tag, never content', () => {
    expect(alertPayload({ title: 'Nekko needs you', body: 'A tool needs your approval.', kind: 'needs-you', tag: 'a'.repeat(32) })).toEqual({
      aps: { alert: { title: 'Nekko needs you', body: 'A tool needs your approval.' }, sound: 'default', 'thread-id': 'a'.repeat(32) },
      kind: 'needs-you',
      tag: 'a'.repeat(32),
    });
    // An older agent's notify: the same body it always had.
    expect(alertPayload({ title: 't', body: 'b' })).toEqual({ aps: { alert: { title: 't', body: 'b' }, sound: 'default' } });
    expect(dismissPayload('b'.repeat(32))).toEqual({ aps: { 'content-available': 1 }, dismiss: 'b'.repeat(32) });
  });
});

const ecKeyP8 = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

describe('makeApnsJwt', () => {
  it('produces a verifiable ES256 JWT with the right header + claims', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const jwt = makeApnsJwt({ keyP8, keyId: 'ABC123', teamId: 'TEAM456' })(1000);

    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: 1000 });

    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('caches within ~50 min and refreshes after', () => {
    const jwt = makeApnsJwt({ keyP8: ecKeyP8(), keyId: 'k', teamId: 't' });
    expect(jwt(1000)).toBe(jwt(2000)); // cached (<3000s)
    expect(jwt(1000)).not.toBe(jwt(5000)); // refreshed past the window
  });
});

describe('makeFcmAssertion', () => {
  it('produces a verifiable RS256 OAuth assertion with the messaging scope', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sa = {
      client_email: 'svc@proj.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      project_id: 'proj',
    };
    const jwt = makeFcmAssertion(sa, 1000);

    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.iss).toBe(sa.client_email);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims).toMatchObject({ iat: 1000, exp: 4600 });

    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('activityPayload', () => {
  it('builds content-free ActivityKit pushes', () => {
    expect(activityPayload({ event: 'update', phase: 'approval', callId: 'tc1', severity: 'high' }, 100)).toEqual({
      aps: {
        timestamp: 100,
        event: 'update',
        'content-state': { phase: 'approval', step: '', steps: 0, callId: 'tc1', severity: 'high' },
        alert: { title: 'Nekko Agent', body: 'A tool needs your approval.' },
      },
    });
    expect(activityPayload({ event: 'end', phase: 'done' }, 100)).toEqual({
      aps: { timestamp: 100, event: 'end', 'content-state': { phase: 'done', step: '', steps: 0 }, 'dismissal-date': 700 },
    });
  });
});
