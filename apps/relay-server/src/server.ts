import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import {
  CARD_LEVELS,
  capBytes,
  cardForLevel,
  cardPriority,
  createPushSender,
  type ActivityPush,
  type CardLevel,
  type CardPush,
  type CardState,
  type PushSender,
} from './push.js';

/**
 * Nekko Agent relay v2, the piece that lets a paired phone reach a local agent
 * (your desktop/server) without inbound ports. Both ends dial in over an
 * outbound WebSocket and are matched by a room code; the relay routes frames
 * between them. It never inspects payloads beyond the routing envelope, so it
 * carries end-to-end-encrypted traffic unchanged (zero-knowledge for content).
 *
 * v2 protocol (see @nekko-agent/shared remote.ts for the same contract):
 *   - every client connection gets a `cid`; client frames reach the agent as
 *     { type:'c', cid, data } and the agent unicasts { type:'d', cid, data }.
 *     No client ever receives another client's traffic.
 *   - the agent may { type:'kick', cid } to force-close a client (revocation).
 *   - { type:'welcomed', cid, deviceId } says a device passed the sealed handshake.
 *     An agent that connects with `proto` sends it, and in that room only such a
 *     connection may register for pushes, under that device id: the room
 *     credential alone is held by every device ever paired, and the card
 *     carries chat text.
 *   - { type:'client-open'|'client-close', cid } keep the agent's view current.
 *   - push: clients register tokens per device, optionally with the `kinds`
 *     they want ('needs-you' | 'finished' | 'failed'), and the relay answers
 *     { type:'push-registered', delivers } (whether it holds the credentials).
 *     The agent's content-free { type:'notify', kind, tag? } fans out to the
 *     phones that asked for that kind when that device is not connected; kind
 *     'test' goes to one `deviceId` whether or not it is connected. { type:'dismiss',
 *     tag } (an approval or question was handled) goes to connected clients as
 *     is and to iPhones as a push. { type:'push-remove', deviceId } drops a
 *     revoked device's token. Badge authority requires a complete agent
 *     { type:'attention-snapshot', tags } on each connection and the phone's
 *     complete `badgeRooms` membership on register-push. Unknown counts are
 *     omitted, never represented by an observed subtotal or a guessed zero.
 *   - Live Activities: an iPhone registers an ActivityKit push token per chat
 *     under an opaque tag (a hash of the session id; { type:'register-activity' }),
 *     and the agent's content-free { type:'activity', tag, phase } updates or
 *     ends it, whether or not the phone looks connected (a suspended app's
 *     socket can linger). Older phones only; newer ones register the card.
 *   - The Live Activity card (one per iPhone, all chats): the phone registers
 *     { type:'register-card', deviceId, token?, startToken?, level,
 *     computerId, computerName, app? } (its card's update token and its
 *     push-to-start token; level 'none' drops it). The agent's { type:'card',
 *     state } updates every registered card, blanked for each phone's level
 *     (Minimal: no title, step or reply; Standard: no reply), and ends it when
 *     the state has no chats; { type:'card-start', state } also starts a card,
 *     once, on a phone with none up and no live socket (one that is open
 *     starts its own). A push that only changes a step goes at priority 5. The card's text passes through the relay
 *     in the clear, as ActivityKit requires.
 *
 * Hardening: pairing-key hashes compared in constant time, frame-size cap, a
 * per-connection token-bucket rate limit, client + room caps, and an optional
 * agent-enrollment gate (NEKKO_RELAY_AUTHZ_URL) for managed/paid hosting.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const hashEq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Parse a relay control frame (plain JSON with a known `type`); else null. */
export function controlFrame(s: string): { type: string; [k: string]: any } | null {
  try {
    const o = JSON.parse(s);
    return o && typeof o.type === 'string' ? o : null;
  } catch {
    return null;
  }
}

export interface RelayLimits {
  /** Max frame size in bytes (chat images ride as data URLs, so generous). */
  maxFrameBytes: number;
  /** Max simultaneously connected clients per room. */
  maxClientsPerRoom: number;
  /** Max rooms held in memory. */
  maxRooms: number;
  /** Token bucket: sustained frames/second per connection. */
  ratePerSec: number;
  /** Token bucket: burst capacity per connection. */
  rateBurst: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxFrameBytes: 10 * 1024 * 1024,
  maxClientsPerRoom: 16,
  maxRooms: 10_000,
  ratePerSec: 40,
  rateBurst: 400,
};

interface Room {
  agent: any | null;
  clients: Map<string, any>;
  /** sha256 of the pairing key, claimed by the agent; clients must match. */
  keyHash: Buffer | null;
  /** Push tokens registered by paired devices, keyed by deviceId. */
  pushTokens: Map<string, PushRegistration>;
  /** Relay-observed waiting chats, independent of Live Activity subscriptions. */
  attention: Set<string>;
  /** Only a complete snapshot on the current agent connection establishes authority. */
  attentionKnown: boolean;
  pushOwners: Map<string, string>;
  /** The agent names who it welcomed, so registering needs that (`welcomed`). */
  gated: boolean;
  /** Connection to the device the agent welcomed on it. */
  welcomed: Map<string, string>;
  /** Live Activity push tokens: tag → deviceId → token. */
  activities: Map<string, Map<string, { token: string; app?: string; at: number }>>;
  /** The Live Activity card per device (`register-card`). */
  cards: Map<string, CardRegistration>;
}

interface PushRegistration {
  token: string;
  platform: 'ios' | 'android';
  app?: string;
  kinds?: string[];
  /** Complete set of this token/topic's needs-you rooms on this relay, supplied by the phone. */
  badgeRooms?: string[];
}

const wantsAttention = (t: PushRegistration) => !t.kinds || t.kinds.includes('needs-you');
const MAX_ATTENTION = 4096;

interface CardRegistration {
  /** The card that is up; gone once it ended. */
  token?: string;
  startToken?: string;
  level: CardLevel;
  computerId: string;
  computerName: string;
  app?: string;
  /** A start was pushed: no other until the phone registers again (with the new card's token). */
  started?: boolean;
  /** What the card last got, for the next push's priority. */
  last?: CardState;
}

/** At most this many Live Activities per room, and how long one is kept without an end. */
const MAX_ACTIVITIES = 64;
/** At most this many phones with a card per room. */
const MAX_CARDS = 64;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVITY_TOKEN = /^[0-9a-fA-F]{20,512}$/;
const ACTIVITY_TTL_MS = 12 * 60 * 60 * 1000;
const PHASES = new Set(['approval', 'question', 'running', 'done', 'failed']);
const APP_ID = /^[A-Za-z0-9.-]{3,155}$/;
/** What a phone can ask to be pushed about; a `notify` without a kind is a finished run (older agents). */
const PUSH_KINDS = new Set(['needs-you', 'finished', 'failed']);
const TAG = /^[0-9a-f]{32}$/;

interface Bucket {
  tokens: number;
  last: number;
}

function allow(b: Bucket, limits: RelayLimits): boolean {
  const now = Date.now();
  b.tokens = Math.min(limits.rateBurst, b.tokens + ((now - b.last) / 1000) * limits.ratePerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export interface RelayOptions {
  limits?: Partial<RelayLimits>;
  /**
   * Managed-hosting gate: when set, agents must connect with `&access=<token>`
   * and the relay authorizes enrollment via `POST <authzUrl>` with a bearer
   * token, expecting `{ ok: true }`. Clients are unaffected (room-key authed).
   */
  authzUrl?: string;
  allowUnauthenticated?: boolean;
  pushSender?: PushSender;
}

export function buildRelay(opts: RelayOptions = {}): { app: FastifyInstance; rooms: Map<string, Room> } {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const pushSender = opts.pushSender ?? createPushSender();
  const authzUrl = opts.authzUrl;
  const allowUnauthenticated = opts.allowUnauthenticated === true;
  const authzCache = new Map<string, { ok: boolean; until: number }>();

  const rooms = new Map<string, Room>();
  const room = (code: string): Room | null => {
    let r = rooms.get(code);
    if (!r) {
      if (rooms.size >= limits.maxRooms) return null;
      r = { agent: null, clients: new Map(), keyHash: null, pushTokens: new Map(), attention: new Set(), attentionKnown: false, pushOwners: new Map(), gated: false, welcomed: new Map(), activities: new Map(), cards: new Map() };
      rooms.set(code, r);
    }
    return r;
  };
  const cleanup = (code: string) => {
    const r = rooms.get(code);
    // Keep registered offline rooms as unknown, not silently absent from app-wide counts.
    // They remain bounded by maxRooms, and disappear when their registrations are revoked.
    if (r && !r.agent && r.clients.size === 0 && r.pushTokens.size === 0) rooms.delete(code);
  };

  // APNs badges are app-wide. Count each room once for a token/topic, even if
  // two device ids registered it. Equal tags in different rooms are distinct.
  const targetKey = (t: PushRegistration) => JSON.stringify([t.token.toLowerCase(), pushSender.apnsTopic?.(t.app) ?? t.app ?? 'dev.nekkolabs.nekkoagent']);
  const badgeCount = (target: PushRegistration): number | undefined => {
    const key = targetKey(target);
    let manifest: string | undefined;
    const contributing = new Set<string>();
    let count = 0;
    for (const [code, r] of rooms) {
      const registrations = [...r.pushTokens.values()].filter((t) => t.platform === 'ios' && targetKey(t) === key);
      for (const t of registrations) {
        // Room snapshots alone cannot prove membership after a relay restart.
        // Require all registrations to agree on the phone's complete room list.
        if (!t.badgeRooms) return undefined;
        const list = JSON.stringify(t.badgeRooms);
        if (manifest !== undefined && manifest !== list) return undefined;
        manifest = list;
      }
      if (!registrations.some(wantsAttention)) continue;
      if (!r.agent || !r.attentionKnown) return undefined;
      contributing.add(code);
      count += r.attention.size;
    }
    if (manifest === undefined || manifest !== JSON.stringify([...contributing].sort())) return undefined;
    return count;
  };
  const sendCurrentBadge = (t: PushRegistration) => sendIos(t, () => {
    const badge = badgeCount(t);
    if (badge !== undefined) return pushSender.sendBadge?.(t.token, badge, t.app);
  });
  // Serialize badge-bearing requests across rooms: a slow older request must
  // not be submitted after a newer zero. APNs delivery itself is best effort.
  const pendingPushes = new Map<string, Promise<void>>();
  const sendIos = (t: PushRegistration, send: () => Promise<void> | undefined) => {
    const key = targetKey(t);
    const next = (pendingPushes.get(key) ?? Promise.resolve()).then(send).then(() => {}, () => {});
    pendingPushes.set(key, next);
    void next.then(() => { if (pendingPushes.get(key) === next) pendingPushes.delete(key); });
  };
  const updateBadges = (r: Room) => {
    const seen = new Set<string>();
    for (const t of r.pushTokens.values()) {
      if (t.platform !== 'ios' || !wantsAttention(t) || seen.has(targetKey(t))) continue;
      seen.add(targetKey(t));
      sendCurrentBadge(t);
    }
  };
  const setAttention = (r: Room, tag: string, waiting: boolean) => {
    if (r.attention.has(tag) === waiting) return;
    if (waiting && r.attention.size >= MAX_ATTENTION) {
      r.attentionKnown = false;
      return;
    }
    waiting ? r.attention.add(tag) : r.attention.delete(tag);
    updateBadges(r);
  };
  const deviceOnline = (r: Room, deviceId: string) =>
    [...r.welcomed].some(([cid, id]) => id === deviceId && r.clients.has(cid)) ||
    (!r.gated && r.clients.has(r.pushOwners.get(deviceId) ?? ''));

  const authorizeAgent = async (access: string | undefined): Promise<boolean> => {
    if (!authzUrl) return allowUnauthenticated;
    if (!access) return false;
    const key = sha256(access).toString('hex');
    const hit = authzCache.get(key);
    if (hit && hit.until > Date.now()) return hit.ok;
    let ok = false;
    try {
      const res = await fetch(authzUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(5000),
      });
      ok = res.ok && ((await res.json()) as { ok?: boolean })?.ok === true;
    } catch {
      ok = false;
    }
    authzCache.set(key, { ok, until: Date.now() + 5 * 60_000 });
    return ok;
  };

  const app = Fastify();
  app.register(websocket, { options: { maxPayload: limits.maxFrameBytes } });

  app.register(async () => {
    app.get('/relay', { websocket: true }, async (socket: any, req) => {
      const q = req.query as Record<string, string>;
      const code = q.room;
      const role = q.role; // 'agent' | 'client'
      // The room credential both ends derive from their pairing secret
      // (relayAuth, decision 0036). The relay never receives the secret itself,
      // so it can match the two ends without being able to derive the E2E key.
      const key = q.key;
      if (!code || !key || (role !== 'agent' && role !== 'client')) {
        socket.close(1008, 'room + role + key required');
        return;
      }
      const hash = sha256(key);
      const r = room(code);
      if (!r) {
        socket.close(1013, 'relay full');
        return;
      }
      const bucket: Bucket = { tokens: limits.rateBurst, last: Date.now() };

      if (role === 'agent') {
        if (!(await authorizeAgent(q.access))) {
          socket.close(
            4003,
            authzUrl
              ? 'relay access denied by NEKKO_RELAY_AUTHZ_URL'
              : 'unauthenticated enrollment disabled; set NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 or configure NEKKO_RELAY_AUTHZ_URL',
          );
          cleanup(code);
          return;
        }
        // First agent claims the room's key; a reconnecting agent must match it.
        if (r.keyHash && !hashEq(r.keyHash, hash)) {
          socket.close(1008, 'bad pairing key');
          cleanup(code);
          return;
        }
        r.keyHash = hash;
        if (q.proto) r.gated = true;
        if (r.agent) r.agent.close(1000, 'replaced by a newer agent');
        r.agent = socket;
        r.attentionKnown = false;
        r.attention.clear();
        for (const [cid, c] of r.clients) {
          safeSend(c, { type: 'agent-online' });
          safeSend(socket, { type: 'client-open', cid });
        }
        socket.on('message', (data: Buffer) => {
          if (r.agent !== socket) return;
          if (!allow(bucket, limits)) {
            r.attentionKnown = false; // A dropped delta may have changed the set.
            return;
          }
          const s = data.toString();
          const ctrl = controlFrame(s);
          if (!ctrl) return; // v2 agents always speak routing envelopes
          switch (ctrl.type) {
            case 'd': {
              const c = r.clients.get(String(ctrl.cid));
              if (c && typeof ctrl.data === 'string') {
                try {
                  c.send(ctrl.data);
                } catch {
                  /* closing */
                }
              }
              return;
            }
            case 'kick': {
              const c = r.clients.get(String(ctrl.cid));
              r.welcomed.delete(String(ctrl.cid));
              if (c) c.close(4001, 'kicked by agent');
              return;
            }
            case 'welcomed': {
              if (r.clients.has(String(ctrl.cid)) && typeof ctrl.deviceId === 'string') r.welcomed.set(String(ctrl.cid), ctrl.deviceId);
              return;
            }
            case 'attention-snapshot': {
              // Atomic, complete replacement. Never truncate an invalid or oversized list.
              if (!Array.isArray(ctrl.tags) || ctrl.tags.length > MAX_ATTENTION ||
                  !ctrl.tags.every((tag: unknown) => typeof tag === 'string' && TAG.test(tag))) {
                r.attentionKnown = false;
                return;
              }
              r.attention = new Set(ctrl.tags);
              r.attentionKnown = true;
              updateBadges(r);
              return;
            }
            case 'attention-unknown': {
              r.attentionKnown = false;
              return;
            }
            case 'notify': {
              const kind = ctrl.kind === 'test' || PUSH_KINDS.has(ctrl.kind) ? String(ctrl.kind) : 'finished';
              const tag = typeof ctrl.tag === 'string' && TAG.test(ctrl.tag) ? ctrl.tag : undefined;
              if (kind !== 'test') {
                if (tag) setAttention(r, tag, kind === 'needs-you');
                else r.attentionKnown = false;
              }
              // Never forward agent-supplied text into an ordinary notification.
              const body = kind === 'needs-you' ? 'Your computer needs your attention.'
                : kind === 'failed' ? 'A task stopped with an error.'
                : kind === 'test' ? 'Test notification: your computer can reach this phone.' : 'Your task finished.';
              const payload = { title: 'Nekko Agent', body, kind, ...(tag ? { tag } : {}) };
              if (kind === 'test') {
                // The phone asked for it, so it goes to that phone even while it is connected.
                const t = typeof ctrl.deviceId === 'string' ? r.pushTokens.get(ctrl.deviceId) : undefined;
                // A test must not create attention or reset the app badge.
                if (t?.platform === 'ios') sendIos(t, () => pushSender.send(t.token, t.platform, payload, t.app));
                else if (t) void pushSender.send(t.token, t.platform, payload, t.app);
                return;
              }
              // A different connected phone must not suppress this device's alert.
              const sent = new Set<string>();
              for (const [deviceId, t] of r.pushTokens) {
                if (deviceOnline(r, deviceId) || (t.kinds && !t.kinds.includes(kind))) continue;
                if (t.platform === 'ios') {
                  if (sent.has(targetKey(t))) continue;
                  sent.add(targetKey(t));
                  sendIos(t, () => {
                    const badge = badgeCount(t);
                    return pushSender.send(t.token, t.platform, { ...payload, ...(badge !== undefined ? { badge } : {}) }, t.app);
                  });
                } else void pushSender.send(t.token, t.platform, payload, t.app);
              }
              return;
            }
            case 'dismiss': {
              if (typeof ctrl.tag !== 'string' || !TAG.test(ctrl.tag)) return;
              setAttention(r, ctrl.tag, false);
              for (const c of r.clients.values()) safeSend(c, { type: 'dismiss', tag: ctrl.tag });
              const seen = new Set<string>();
              for (const t of r.pushTokens.values()) {
                if (t.platform !== 'ios' || !wantsAttention(t) || seen.has(targetKey(t))) continue;
                seen.add(targetKey(t));
                sendIos(t, () => pushSender.sendDismiss?.(t.token, ctrl.tag, t.app, badgeCount(t)));
              }
              return;
            }
            case 'push-remove': {
              if (typeof ctrl.deviceId === 'string') {
                const previous = r.pushTokens.get(ctrl.deviceId);
                r.pushTokens.delete(ctrl.deviceId);
                // Recompute only if remaining membership still proves a complete total.
                // A removed room in an old manifest stays unknown until the phone refreshes it.
                if (previous?.platform === 'ios' && wantsAttention(previous)) {
                  sendCurrentBadge(previous);
                }
                for (const devices of r.activities.values()) devices.delete(ctrl.deviceId);
                r.cards.delete(ctrl.deviceId);
              }
              return;
            }
            case 'activity': {
              const tag = typeof ctrl.tag === 'string' ? ctrl.tag : '';
              if (!TAG.test(tag) || !PHASES.has(ctrl.phase)) return;
              setAttention(r, tag, ctrl.phase === 'approval' || ctrl.phase === 'question');
              const devices = r.activities.get(tag);
              if (!devices) return;
              const end = ctrl.phase === 'done' || ctrl.phase === 'failed';
              const push: ActivityPush = { event: end ? 'end' : 'update', phase: ctrl.phase };
              if (ctrl.phase === 'approval' && typeof ctrl.callId === 'string' && ctrl.callId.length <= 200) {
                push.callId = ctrl.callId;
                push.severity = ctrl.severity === 'high' || ctrl.severity === 'medium' ? ctrl.severity : 'low';
              }
              for (const { token, app } of devices.values()) void pushSender.sendActivity?.(token, push, app);
              if (end) r.activities.delete(tag);
              return;
            }
            case 'card':
            case 'card-start': {
              const start = ctrl.type === 'card-start';
              for (const [deviceId, reg] of r.cards) {
                const state = cardForLevel(ctrl.state, reg.level);
                if (!state) return;
                const ended = state.chats.length === 0;
                // A phone with a live socket starts its own card (its token may not have arrived yet).
                const owner = r.pushOwners.get(deviceId);
                const live = owner !== undefined && r.clients.has(owner);
                if (reg.token) {
                  const push: CardPush = { event: ended ? 'end' : 'update', state };
                  push.priority = cardPriority(reg.last, push);
                  void pushSender.sendCard?.(reg.token, push, reg.app);
                  reg.last = state;
                  if (ended) {
                    delete reg.token;
                    delete reg.last;
                    if (!reg.startToken) r.cards.delete(deviceId);
                  }
                } else if (start && !ended && !live && reg.startToken && !reg.started) {
                  reg.started = true;
                  const attributes = { computerId: reg.computerId, computerName: reg.computerName, level: reg.level };
                  void pushSender.sendCard?.(reg.startToken, { event: 'start', state, attributes, priority: 10 }, reg.app);
                }
              }
              return;
            }
            default:
              return; // unknown agent frames are dropped, never broadcast
          }
        });
        socket.on('close', () => {
          // A replaced agent's late close says nothing: its successor is online.
          if (r.agent === socket) {
            r.agent = null;
            r.attentionKnown = false;
            for (const c of r.clients.values()) safeSend(c, { type: 'agent-offline' });
          }
          cleanup(code);
        });
      } else {
        // Clients can only join a room an agent has claimed, with the right key.
        if (!r.keyHash) {
          socket.close(1008, 'room not paired (agent offline)');
          cleanup(code);
          return;
        }
        if (!hashEq(r.keyHash, hash)) {
          socket.close(1008, 'bad pairing key');
          cleanup(code);
          return;
        }
        if (r.clients.size >= limits.maxClientsPerRoom) {
          socket.close(1013, 'room full');
          return;
        }
        const cid = randomBytes(6).toString('hex');
        r.clients.set(cid, socket);
        safeSend(socket, { type: r.agent ? 'agent-online' : 'agent-offline' });
        if (r.agent) safeSend(r.agent, { type: 'client-open', cid });
        socket.on('message', (data: Buffer) => {
          if (!allow(bucket, limits)) return;
          const s = data.toString();
          const ctrl = controlFrame(s);
          if (typeof ctrl?.type === 'string' && ctrl.type.startsWith('register-') && r.gated && r.welcomed.get(cid) !== ctrl.deviceId) return;
          if (ctrl?.type === 'register-push') {
            const deviceId = typeof ctrl.deviceId === 'string' ? ctrl.deviceId : '';
            const token = typeof ctrl.token === 'string' ? ctrl.token : '';
            const platform = ctrl.platform === 'android' ? 'android' : ctrl.platform === 'ios' ? 'ios' : '';
            const validDevice = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId);
            // APNs tokens are hex; FCM registration tokens also carry ':'.
            const validToken = /^[A-Za-z0-9_:-]{20,4096}$/.test(token);
            const owner = r.pushOwners.get(deviceId);
            const app = typeof ctrl.app === 'string' && APP_ID.test(ctrl.app) ? ctrl.app : undefined;
            // Absent means every kind (phones from before per-type settings).
            const kinds: string[] | undefined = Array.isArray(ctrl.kinds)
              ? [...new Set<string>(ctrl.kinds.filter((k: unknown) => typeof k === 'string' && PUSH_KINDS.has(k)))]
              : undefined;
            const badgeRooms = Array.isArray(ctrl.badgeRooms) && ctrl.badgeRooms.length <= 64 &&
              ctrl.badgeRooms.every((code: unknown) => typeof code === 'string' && code.length > 0 && code.length <= 256)
              ? [...new Set<string>(ctrl.badgeRooms)].sort() : undefined;
            if (validDevice && validToken && platform && (!owner || owner === cid)) {
              const previous = r.pushTokens.get(deviceId);
              r.pushOwners.set(deviceId, cid);
              r.pushTokens.set(deviceId, {
                token: platform === 'ios' ? token.toLowerCase() : token,
                platform,
                ...(app ? { app } : {}),
                ...(kinds ? { kinds } : {}),
                ...(badgeRooms ? { badgeRooms } : {}),
              });
              const current = r.pushTokens.get(deviceId)!;
              if (current.platform === 'ios') sendCurrentBadge(current);
              if (previous?.platform === 'ios' && targetKey(previous) !== targetKey(current)) sendCurrentBadge(previous);
              // No badge (not even zero) until snapshots and the full membership agree.
              // So the phone's *Send a test notification* can say which path it took.
              safeSend(socket, { type: 'push-registered', delivers: pushSender.delivers ? pushSender.delivers(platform) : pushSender.enabled });
            }
            return;
          }
          if (ctrl?.type === 'register-card') {
            const deviceId = typeof ctrl.deviceId === 'string' && DEVICE_ID.test(ctrl.deviceId) ? ctrl.deviceId : '';
            const level = ctrl.level === 'none' || CARD_LEVELS.has(ctrl.level) ? (ctrl.level as CardLevel | 'none') : '';
            const token = (v: unknown) => (typeof v === 'string' && ACTIVITY_TOKEN.test(v) ? v : undefined);
            const owner = r.pushOwners.get(deviceId);
            if (!deviceId || !level || (owner && owner !== cid)) return;
            if ((ctrl.token !== undefined && !token(ctrl.token)) || (ctrl.startToken !== undefined && !token(ctrl.startToken))) return;
            r.pushOwners.set(deviceId, cid);
            if (level === 'none' || (!ctrl.token && !ctrl.startToken)) {
              r.cards.delete(deviceId);
              return;
            }
            if (!r.cards.has(deviceId) && r.cards.size >= MAX_CARDS) return;
            // Capped so a start's attributes keep the payload under 4 KB.
            const name = (v: unknown) => capBytes(v, 64);
            const app = typeof ctrl.app === 'string' && APP_ID.test(ctrl.app) ? ctrl.app : undefined;
            r.cards.set(deviceId, {
              ...(token(ctrl.token) ? { token: ctrl.token } : {}),
              ...(token(ctrl.startToken) ? { startToken: ctrl.startToken } : {}),
              level,
              computerId: name(ctrl.computerId),
              computerName: name(ctrl.computerName),
              ...(app ? { app } : {}),
            });
            return;
          }
          if (ctrl?.type === 'register-activity') {
            const deviceId = typeof ctrl.deviceId === 'string' ? ctrl.deviceId : '';
            const token = typeof ctrl.token === 'string' ? ctrl.token : '';
            const tag = typeof ctrl.tag === 'string' ? ctrl.tag : '';
            const app = typeof ctrl.app === 'string' && APP_ID.test(ctrl.app) ? ctrl.app : undefined;
            const valid =
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) &&
              /^[0-9a-f]{32}$/.test(tag) &&
              /^[0-9a-fA-F]{20,512}$/.test(token);
            const owner = r.pushOwners.get(deviceId);
            if (valid && (!owner || owner === cid)) {
              r.pushOwners.set(deviceId, cid);
              const now = Date.now();
              for (const [t, devices] of r.activities) {
                for (const [d, a] of devices) if (now - a.at > ACTIVITY_TTL_MS) devices.delete(d);
                if (devices.size === 0) r.activities.delete(t);
              }
              if (!r.activities.has(tag) && r.activities.size >= MAX_ACTIVITIES) {
                const oldest = r.activities.keys().next().value;
                if (oldest !== undefined) r.activities.delete(oldest);
              }
              const devices = r.activities.get(tag) ?? new Map();
              devices.set(deviceId, { token, at: now, ...(app ? { app } : {}) });
              r.activities.set(tag, devices);
            }
            return;
          }
          if (r.agent) safeSend(r.agent, { type: 'c', cid, data: s });
          else safeSend(socket, { type: 'agent-offline' });
        });
        socket.on('close', () => {
          r.clients.delete(cid);
          r.welcomed.delete(cid);
          for (const [deviceId, owner] of r.pushOwners) {
            if (owner === cid) r.pushOwners.delete(deviceId);
          }
          if (r.agent) safeSend(r.agent, { type: 'client-close', cid });
          cleanup(code);
        });
      }
    });
  });

  app.get('/healthz', async () => ({ ok: true, rooms: rooms.size }));

  return { app, rooms };
}

function safeSend(socket: any, obj: unknown) {
  try {
    socket.send(JSON.stringify(obj));
  } catch {
    /* socket closing */
  }
}
