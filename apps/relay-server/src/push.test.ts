import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { activityPayload, alertPayload, badgePayload, capBytes, cardForLevel, cardPayload, cardPriority, createPushSender, dismissPayload, makeApnsJwt, makeFcmAssertion } from './push.js';

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

describe('attention badge payloads', () => {
  it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])('carries an absolute badge of %s, including a resolving zero', (badge) => {
    expect(alertPayload({ title: 'Nekko Agent', body: 'Needs you', badge }).aps.badge).toBe(badge);
    expect(dismissPayload('a'.repeat(32), badge)).toEqual({ aps: { 'content-available': 1, badge }, dismiss: 'a'.repeat(32) });
    expect(badgePayload(badge)).toEqual({ aps: { badge } });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('never publishes invalid badge %s', (badge) => {
    expect(alertPayload({ title: 't', body: 'b', badge }).aps).not.toHaveProperty('badge');
    expect(dismissPayload('tag', badge).aps).not.toHaveProperty('badge');
    expect(() => badgePayload(badge)).toThrow('invalid badge count');
  });

  it('omits unknown counts and canonicalizes the actual APNs topic, not arbitrary app aliases', () => {
    expect(alertPayload({ title: 't', body: 'b' }).aps).not.toHaveProperty('badge');
    expect(dismissPayload('tag').aps).not.toHaveProperty('badge');
    const sender = createPushSender({ APNS_BUNDLE_ID: 'dev.default', APNS_EXTRA_BUNDLE_IDS: ' dev.extra ' });
    expect(sender.apnsTopic?.()).toBe('dev.default');
    expect(sender.apnsTopic?.('dev.unlisted')).toBe('dev.default');
    expect(sender.apnsTopic?.('dev.extra')).toBe('dev.extra');
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

describe('the Live Activity card', () => {
  const chat = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    short: 'Fix',
    title: 'Fix the login bug',
    state: 'working',
    step: 'Run npm test',
    reply: 'On it.',
    closeWord: 'Cool',
    startedAt: 799999000,
    ...extra,
  });
  const state = { chats: [chat('a'), chat('b', { state: 'needsYou', callId: 'tc1', severity: 'high' })], focusId: 'b', more: 0, listening: false, heard: '' };

  it('blanks text per level: Minimal none, Standard no reply, Detailed all', () => {
    const minimal = cardForLevel(state, 'minimal')!;
    expect(minimal.chats.map((c) => [c.short, c.step, c.reply])).toEqual([['', '', ''], ['', '', '']]);
    expect(minimal.chats.some((c) => 'title' in c)).toBe(false);
    expect(minimal.chats[1]).toMatchObject({ id: 'b', state: 'needsYou', callId: 'tc1', severity: 'high', closeWord: 'Cool' });
    expect(cardForLevel(state, 'standard')!.chats[0]).toMatchObject({ short: 'Fix', title: 'Fix the login bug', step: 'Run npm test', reply: '' });
    expect(cardForLevel(state, 'detailed')!.chats[0]).toEqual(chat('a'));
    expect(cardForLevel(state, 'detailed')).toMatchObject({ focusId: 'b', more: 0, listening: false, heard: '' });
  });

  it('keeps dates as numbers (seconds since 2001) and drops what it does not know', () => {
    const odd = { chats: [{ ...chat('a'), finishedAt: 800000000.5, extra: 'x' }, { state: 'done' }, 'nope'], focusId: 7, junk: true };
    const card = cardForLevel(odd, 'detailed')!;
    expect(card.chats).toEqual([{ ...chat('a'), finishedAt: 800000000.5 }]);
    expect(card).toEqual({ chats: card.chats, more: 0, listening: false, heard: '' });
    expect(cardForLevel(null, 'detailed')).toBeNull();
    expect(cardForLevel({ chats: 'x' }, 'detailed')).toBeNull();
  });

  it('clips step and reply to 60 characters and stays under 4 KB', () => {
    const long = cardForLevel({ chats: [chat('a', { step: 'x'.repeat(200), reply: 'y'.repeat(200) })] }, 'detailed')!;
    expect([...long.chats[0].step as string].length).toBe(60);
    expect(long.chats[0].step).toBe('x'.repeat(59) + '…');
    expect([...long.chats[0].reply as string].length).toBe(60);
    const huge = {
      chats: Array.from({ length: 12 }, (_, i) => chat(`chat-${i}-${'i'.repeat(150)}`, { callId: 'c'.repeat(150), reply: 'r'.repeat(60) })),
      focusId: `chat-7-${'i'.repeat(150)}`,
    };
    const card = cardForLevel(huge, 'detailed')!;
    const attributes = { computerId: capBytes('m'.repeat(300), 64), computerName: capBytes('ñ'.repeat(300), 64), level: 'detailed' as const };
    expect(Buffer.byteLength(JSON.stringify(cardPayload({ event: 'start', state: card, attributes }, 1e10)))).toBeLessThan(4096);
    expect(card.chats.length + (card.more as number)).toBe(12);
    expect(card.chats.some((c) => c.id === huge.focusId)).toBe(true);
  });

  it('preserves full-set totals at every level, including when details exceed either limit', () => {
    const counts = { needsYou: 1, working: 12, watching: 2, done: 20, failed: 1 };
    const huge = {
      chats: Array.from({ length: 12 }, (_, i) => chat(`chat-${i}-${'i'.repeat(150)}`, { callId: 'c'.repeat(150) })),
      counts,
      more: 24,
    };
    for (const level of ['minimal', 'standard', 'detailed'] as const) {
      const card = cardForLevel(huge, level)!;
      expect(card.counts).toEqual(counts);
      expect(card.chats.length).toBeLessThanOrEqual(8);
      expect(card.chats.length + card.more!).toBe(36);
      expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(3500);
    }
    expect(cardForLevel(huge, 'detailed')!.chats.length).toBeLessThan(8);
    expect(cardForLevel(state, 'detailed')).not.toHaveProperty('counts');
    expect(cardForLevel({ chats: [], counts: {} }, 'minimal')!.counts).toEqual({});
  });

  it('preserves the shared producer fixture totals at every privacy level', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/live-card.json', import.meta.url), 'utf8')) as {
      build: { name: string; card: { chats: Record<string, unknown>[]; counts: Record<string, number> } | null }[];
    };
    for (const entry of fixture.build) {
      if (!entry.card) continue;
      for (const level of ['minimal', 'standard', 'detailed'] as const) {
        expect(cardForLevel(entry.card, level)!.counts, `${entry.name}: ${level}`).toEqual(entry.card.counts);
      }
    }
  });

  it('drops invalid aggregate maps rather than claiming partially authoritative totals', () => {
    for (const counts of [[], 'bad', null, { done: -1 }, { done: 1.5 }, { done: Infinity }, { done: '20' }, { done: 2147483648 }, { done: 20, unknown: 1 }]) {
      expect(cardForLevel({ ...state, counts }, 'detailed')).not.toHaveProperty('counts');
    }
    expect(cardForLevel({ ...state, counts: { working: 0, done: 20 } }, 'minimal')!.counts).toEqual({ working: 0, done: 20 });
  });

  it('raises priority for count-only transitions but not map ordering', () => {
    const previous = { ...state, counts: { working: 2, done: 20 } };
    expect(cardPriority(previous, { event: 'update', state: { ...previous, counts: { working: 1, done: 21 } } })).toBe(10);
    expect(cardPriority(previous, { event: 'update', state: { ...previous, counts: { done: 20, working: 2 } } })).toBe(5);
    expect(cardPriority(state, { event: 'update', state: previous })).toBe(10);
  });

  it('builds start, update and end payloads', () => {
    const card = cardForLevel(state, 'standard')!;
    expect(cardPayload({ event: 'update', state: card }, 100)).toEqual({
      aps: { timestamp: 100, event: 'update', 'content-state': card, 'stale-date': 1000 },
    });
    expect(cardPayload({ event: 'end', state: { chats: [] } }, 100)).toEqual({
      aps: { timestamp: 100, event: 'end', 'content-state': { chats: [] }, 'dismissal-date': 100 },
    });
    const attributes = { computerId: 'mac-1', computerName: 'Studio', level: 'standard' as const };
    expect(cardPayload({ event: 'start', state: card, attributes }, 100)).toEqual({
      aps: {
        timestamp: 100,
        event: 'start',
        'content-state': card,
        'stale-date': 1000,
        'attributes-type': 'NekkoCardAttributes',
        attributes,
        alert: { title: 'Nekko Agent', body: 'Your computer is working on a chat.' },
      },
    });
  });
});

describe('card names and priority', () => {
  it('caps a name at 64 UTF-8 bytes on a character boundary', () => {
    expect(capBytes('a'.repeat(70), 64)).toBe('a'.repeat(64));
    expect(capBytes('é'.repeat(40), 64)).toBe('é'.repeat(32));
    expect(capBytes('x' + '😀'.repeat(20), 64)).toBe('x' + '😀'.repeat(15));
    expect(capBytes('Studio', 64)).toBe('Studio');
    expect(capBytes(7, 64)).toBe('');
  });

  it('sends a step-only update at priority 5 and anything else at 10', () => {
    const chat = (state: string, step: string, extra: Record<string, unknown> = {}) => ({ id: 'a', state, step, ...extra });
    const card = (chats: Record<string, unknown>[], focusId = 'a', more = 0) => ({ chats, focusId, more });
    const was = card([chat('working', 'Run ls')]);
    const update = (state: ReturnType<typeof card>) => ({ event: 'update' as const, state });
    expect(cardPriority(was, update(card([chat('working', 'Run pwd', { reply: 'Hm.', startedAt: 9 })])))).toBe(5);
    expect(cardPriority(was, update(card([chat('needsYou', 'Run ls', { callId: 'c' })])))).toBe(10);
    expect(cardPriority(was, update(card([chat('working', 'Run ls'), { id: 'b', state: 'working' }])))).toBe(10);
    expect(cardPriority(was, update(card([chat('working', 'Run ls')], 'b')))).toBe(10);
    expect(cardPriority(was, update(card([chat('working', 'Run ls')], 'a', 1)))).toBe(10);
    expect(cardPriority(undefined, update(was))).toBe(10);
    expect(cardPriority(was, { event: 'start', state: was })).toBe(10);
    expect(cardPriority(was, { event: 'end', state: card([]) })).toBe(10);
  });
});
