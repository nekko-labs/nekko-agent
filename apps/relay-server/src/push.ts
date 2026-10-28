import http2 from 'node:http2';
import { createPrivateKey, sign as cryptoSign, createSign, type KeyObject } from 'node:crypto';

/**
 * Relay-side push sender. The relay is the one always-on piece, so it holds the
 * push credentials (server secrets) and sends a **content-free** notification to
 * a paired phone when its desktop signals a finished run while the phone is
 * offline. The relay never sees the (E2E-encrypted) conversation, only the
 * "a run finished" signal, so a generic body keeps the zero-knowledge property.
 *
 * APNs is implemented natively (HTTP/2 + ES256 JWT, no dependency). FCM is a
 * documented stub until a Google service account is configured.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** What it is about ('needs-you' | 'finished' | 'failed' | 'test'); the phone groups and dismisses by it. */
  kind?: string;
  /** The chat's opaque tag (a hash of the session id), so a later `dismiss` can find it. */
  tag?: string;
}

/** The APNs body of an alert push: content-free, plus the kind and the chat's opaque tag (exported for tests). */
export function alertPayload(payload: PushPayload) {
  const aps: Record<string, unknown> = { alert: { title: payload.title, body: payload.body }, sound: 'default' };
  if (payload.tag) aps['thread-id'] = payload.tag;
  return { aps, ...(payload.kind ? { kind: payload.kind } : {}), ...(payload.tag ? { tag: payload.tag } : {}) };
}

/** A silent push that tells an iPhone to remove the delivered notification for a chat (exported for tests). */
export function dismissPayload(tag: string) {
  return { aps: { 'content-available': 1 }, dismiss: tag };
}

/**
 * A Live Activity update for an iPhone (ActivityKit push). Content-free like
 * every other push: a phase, and for an approval the opaque call id and the
 * risk level the phone's buttons need; the step text stays empty and the app
 * fills it in once it runs again.
 */
export interface ActivityPush {
  event: 'update' | 'end';
  phase: 'approval' | 'question' | 'running' | 'done' | 'failed';
  callId?: string;
  severity?: 'low' | 'medium' | 'high';
}

/** What a phone asked its card to show (`register-card`); `none` drops the registration. */
export type CardLevel = 'minimal' | 'standard' | 'detailed';
export const CARD_LEVELS: ReadonlySet<string> = new Set<CardLevel>(['minimal', 'standard', 'detailed']);

/** The iPhone card's `NekkoCardAttributes`, for a push-to-start. */
export interface CardAttributes {
  computerId: string;
  computerName: string;
  level: CardLevel;
}

/** A card the agent built (`card` / `card-start`), as one phone may see it. */
export interface CardState {
  chats: Record<string, unknown>[];
  focusId?: string;
  more?: number;
  listening?: boolean;
  heard?: string;
}

/**
 * A push to the iPhone's one Live Activity card. Unlike every other push it
 * carries the chats' text (titles, steps, reply lines, at the level the phone
 * asked for): ActivityKit draws only what the push holds, in the clear.
 */
export interface CardPush {
  event: 'start' | 'update' | 'end';
  state: CardState;
  /** For `start`. */
  attributes?: CardAttributes;
}

/** APNs refuses a Live Activity payload over 4 KB: the state gets 3500 bytes, as `buildCard` allows it. */
const CARD_STATE_BYTES = 3500;
const CHAT_STATES = new Set(['needsYou', 'working', 'watching', 'done', 'failed']);
const SEVERITIES = new Set(['low', 'medium', 'high']);

/** At most `max` characters, the last an ellipsis when cut (the card's `oneLine`). */
const clip = (v: unknown, max: number) => {
  const chars = [...(typeof v === 'string' ? v : '')];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
};
const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);
const date = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The agent's card as a phone at `level` may see it (exported for tests):
 * Minimal blanks the title, step and reply, Standard the reply. Only the
 * fields `LiveCardState` decodes are kept, text clipped, and the last chats
 * (never the focused one) move into `more` while the push would pass 4 KB.
 * Null when the agent sent no card.
 */
export function cardForLevel(state: unknown, level: CardLevel): CardState | null {
  const s = state as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.chats)) return null;
  const chats: Record<string, unknown>[] = [];
  for (const c of s.chats.slice(0, 8) as Record<string, unknown>[]) {
    if (!c || typeof c !== 'object' || !id(c.id) || typeof c.state !== 'string') continue;
    const chat: Record<string, unknown> = {
      id: c.id,
      short: level === 'minimal' ? '' : clip(c.short, 20),
      state: CHAT_STATES.has(c.state) ? c.state : 'working',
      step: level === 'minimal' ? '' : clip(c.step, 60),
      reply: level === 'detailed' ? clip(c.reply, 60) : '',
      closeWord: clip(c.closeWord, 20),
    };
    if (date(c.finishedAt) !== undefined) chat.finishedAt = c.finishedAt;
    if (date(c.startedAt) !== undefined) chat.startedAt = c.startedAt;
    if (id(c.callId)) chat.callId = c.callId;
    if (typeof c.severity === 'string' && SEVERITIES.has(c.severity)) chat.severity = c.severity;
    chats.push(chat);
  }
  const card: CardState = { chats };
  if (id(s.focusId)) card.focusId = s.focusId as string;
  card.more = Math.max(0, Math.floor(date(s.more) ?? 0)) + Math.max(0, s.chats.length - 8);
  card.listening = s.listening === true;
  card.heard = clip(s.heard, 200);
  // The state's budget, as on the computer and the phone; the rest of the payload stays under 600 bytes.
  const big = () => Buffer.byteLength(JSON.stringify(card)) > CARD_STATE_BYTES;
  if (big()) for (const c of chats) c.reply = '';
  for (let i = chats.length - 1; i >= 0 && big(); i--) {
    if (chats[i].id === card.focusId) continue;
    chats.splice(i, 1);
    card.more += 1;
  }
  return card;
}

/** The APNs body of a card push (exported for tests). A card the computer stops updating reads as stale after 15 minutes. */
export function cardPayload(push: CardPush, nowSec: number = Math.floor(Date.now() / 1000)) {
  const aps: Record<string, unknown> = { timestamp: nowSec, event: push.event, 'content-state': push.state };
  if (push.event === 'end') aps['dismissal-date'] = nowSec;
  else aps['stale-date'] = nowSec + 15 * 60;
  if (push.event === 'start') {
    aps['attributes-type'] = 'NekkoCardAttributes';
    aps.attributes = push.attributes;
    // ActivityKit needs an alert to start a Live Activity from a push.
    aps.alert = { title: 'Nekko Agent', body: 'Your computer is working on a chat.' };
  }
  return { aps };
}

export interface PushSender {
  enabled: boolean;
  /** Whether this relay holds the credentials to push to that platform (told to the phone). */
  delivers?(platform: 'ios' | 'android'): boolean;
  /** `app` is the iPhone app's bundle id when the phone named one the relay allows. */
  send(token: string, platform: 'ios' | 'android', payload: PushPayload, app?: string): Promise<void>;
  sendActivity?(token: string, push: ActivityPush, app?: string): Promise<void>;
  /** The iPhone's one Live Activity card: `token` is its update token, or its push-to-start token for `start`. */
  sendCard?(token: string, push: CardPush, app?: string): Promise<void>;
  /** A silent push removing a chat's delivered notification (iPhone only). */
  sendDismiss?(token: string, tag: string, app?: string): Promise<void>;
}

/** The APNs body of a Live Activity push (exported for tests). */
export function activityPayload(push: ActivityPush, nowSec: number = Math.floor(Date.now() / 1000)) {
  const state: Record<string, unknown> = { phase: push.phase, step: '', steps: 0 };
  if (push.callId) state.callId = push.callId;
  if (push.severity) state.severity = push.severity;
  const aps: Record<string, unknown> = { timestamp: nowSec, event: push.event, 'content-state': state };
  if (push.event === 'end') aps['dismissal-date'] = nowSec + 10 * 60;
  // Light the Lock Screen up when the computer is waiting on the phone.
  if (push.phase === 'approval' || push.phase === 'question') {
    aps.alert = { title: 'Nekko Agent', body: push.phase === 'approval' ? 'A tool needs your approval.' : 'Your computer has a question.' };
  }
  return { aps };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * Build an APNs provider JWT (ES256), cached for ~50 min as Apple recommends.
 * Exported for unit testing. `nowSec` is injectable for deterministic tests.
 */
export function makeApnsJwt(opts: { keyP8: string; keyId: string; teamId: string }) {
  const key: KeyObject = createPrivateKey(opts.keyP8);
  let cached = '';
  let cachedAt = 0;
  return (nowSec: number = Math.floor(Date.now() / 1000)): string => {
    if (cached && nowSec - cachedAt < 3000) return cached;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: opts.keyId }));
    const payload = b64url(JSON.stringify({ iss: opts.teamId, iat: nowSec }));
    const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
    cached = `${header}.${payload}.${b64url(sig)}`;
    cachedAt = nowSec;
    return cached;
  };
}

async function sendApns(
  host: string,
  jwt: string,
  topic: string,
  token: string,
  body: unknown,
  pushType: 'alert' | 'liveactivity' | 'background' = 'alert',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': pushType,
      // Apple requires priority 5 for a background (silent) push.
      'apns-priority': pushType === 'background' ? '5' : '10',
      'content-type': 'application/json',
    });
    let status = 0;
    req.on('response', (h) => (status = Number(h[':status'])));
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      client.close();
      status >= 200 && status < 300 ? resolve() : reject(new Error(`APNs ${status}: ${data}`));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/**
 * Build a Google OAuth2 JWT assertion (RS256) for the FCM messaging scope.
 * Exported for unit testing; `nowSec` injectable.
 */
export function makeFcmAssertion(sa: ServiceAccount, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

/** Exchange the assertion for an access token (cached ~55 min). */
function fcmTokenProvider(sa: ServiceAccount) {
  let token = '';
  let exp = 0;
  return async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < exp - 60) return token;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeFcmAssertion(sa, now),
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`FCM token ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = j.access_token;
    exp = now + (j.expires_in ?? 3600);
    return token;
  };
}

async function sendFcm(projectId: string, accessToken: string, token: string, payload: PushPayload): Promise<void> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: payload.title, body: payload.body } } }),
  });
  if (!res.ok) throw new Error(`FCM ${res.status}: ${await res.text()}`);
}

function parseServiceAccount(raw?: string): ServiceAccount | null {
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key && sa.project_id ? sa : null;
  } catch {
    return null;
  }
}

export function createPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  const keyP8 = env.APNS_KEY_P8;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const bundleId = env.APNS_BUNDLE_ID ?? 'dev.nekkolabs.nekkoagent';
  // Other iPhone apps the same APNs key may reach, named by the phone (none by default).
  const extraApps = new Set((env.APNS_EXTRA_BUNDLE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const topicFor = (app?: string) => (app && extraApps.has(app) ? app : bundleId);
  const apnsHost = env.APNS_PRODUCTION === '1' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const apnsReady = !!(keyP8 && keyId && teamId);
  const apnsJwt = apnsReady ? makeApnsJwt({ keyP8: keyP8!, keyId: keyId!, teamId: teamId! }) : null;

  const serviceAccount = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
  const fcmReady = !!serviceAccount;
  const fcmToken = serviceAccount ? fcmTokenProvider(serviceAccount) : null;

  return {
    enabled: apnsReady || fcmReady,
    delivers: (platform) => (platform === 'ios' ? apnsReady : fcmReady),
    async sendDismiss(token, tag, app) {
      try {
        if (!apnsJwt) return;
        await sendApns(apnsHost, apnsJwt(), topicFor(app), token, dismissPayload(tag), 'background');
        console.log('[push] dismissal sent');
      } catch (e) {
        console.warn(`[push] dismissal failed: ${(e as Error).message}`);
      }
    },
    async sendActivity(token, push, app) {
      try {
        if (!apnsJwt) return void console.log('[push] APNs not configured (set APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)');
        await sendApns(apnsHost, apnsJwt(), `${topicFor(app)}.push-type.liveactivity`, token, activityPayload(push), 'liveactivity');
        console.log(`[push] Live Activity ${push.event} sent`);
      } catch (e) {
        console.warn(`[push] activity send failed: ${(e as Error).message}`);
      }
    },
    async sendCard(token, push, app) {
      try {
        if (!apnsJwt) return void console.log('[push] APNs not configured (set APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)');
        await sendApns(apnsHost, apnsJwt(), `${topicFor(app)}.push-type.liveactivity`, token, cardPayload(push), 'liveactivity');
        console.log(`[push] card ${push.event} sent`);
      } catch (e) {
        console.warn(`[push] card send failed: ${(e as Error).message}`);
      }
    },
    async send(token, platform, payload, app) {
      try {
        if (platform === 'ios') {
          if (!apnsJwt) return void console.log('[push] APNs not configured (set APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)');
          await sendApns(apnsHost, apnsJwt(), topicFor(app), token, alertPayload(payload));
          console.log('[push] APNs sent');
        } else {
          if (!fcmToken || !serviceAccount) return void console.log('[push] FCM not configured (set FCM_SERVICE_ACCOUNT)');
          await sendFcm(serviceAccount.project_id, await fcmToken(), token, payload);
          console.log('[push] FCM sent');
        }
      } catch (e) {
        console.warn(`[push] send failed: ${(e as Error).message}`);
      }
    },
  };
}
