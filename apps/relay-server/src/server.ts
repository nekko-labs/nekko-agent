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
 *   - { type:'client-open'|'client-close', cid } keep the agent's view current.
 *   - push: clients register tokens per device, optionally with the `kinds`
 *     they want ('needs-you' | 'finished' | 'failed'), and the relay answers
 *     { type:'push-registered', delivers } (whether it holds the credentials).
 *     The agent's content-free { type:'notify', kind, tag? } fans out to the
 *     phones that asked for that kind when none are connected; kind 'test'
 *     goes to one `deviceId` whether or not it is connected. { type:'dismiss',
 *     tag } (an approval or question was handled) goes to connected clients as
 *     is and to iPhones as a silent push. { type:'push-remove', deviceId }
 *     drops a revoked device's token.
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
  pushTokens: Map<string, { token: string; platform: 'ios' | 'android'; app?: string; kinds?: string[] }>;
  pushOwners: Map<string, string>;
  /** Live Activity push tokens: tag → deviceId → token. */
  activities: Map<string, Map<string, { token: string; app?: string; at: number }>>;
  /** The Live Activity card per device (`register-card`). */
  cards: Map<string, CardRegistration>;
}

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
      r = { agent: null, clients: new Map(), keyHash: null, pushTokens: new Map(), pushOwners: new Map(), activities: new Map(), cards: new Map() };
      rooms.set(code, r);
    }
    return r;
  };
  const cleanup = (code: string) => {
    const r = rooms.get(code);
    if (r && !r.agent && r.clients.size === 0) rooms.delete(code);
  };

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
        if (r.agent) r.agent.close(1000, 'replaced by a newer agent');
        r.agent = socket;
        for (const [cid, c] of r.clients) {
          safeSend(c, { type: 'agent-online' });
          safeSend(socket, { type: 'client-open', cid });
        }
        socket.on('message', (data: Buffer) => {
          if (r.agent !== socket) return;
          if (!allow(bucket, limits)) return;
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
              if (c) c.close(4001, 'kicked by agent');
              return;
            }
            case 'notify': {
              const kind = ctrl.kind === 'test' || PUSH_KINDS.has(ctrl.kind) ? String(ctrl.kind) : 'finished';
              const payload = {
                title: String(ctrl.title || 'Nekko Agent'),
                body: String(ctrl.body || 'Your task finished.'),
                kind,
                ...(typeof ctrl.tag === 'string' && TAG.test(ctrl.tag) ? { tag: ctrl.tag } : {}),
              };
              if (kind === 'test') {
                // The phone asked for it, so it goes to that phone even while it is connected.
                const t = typeof ctrl.deviceId === 'string' ? r.pushTokens.get(ctrl.deviceId) : undefined;
                if (t) void pushSender.send(t.token, t.platform, payload, t.app);
                return;
              }
              // Content-free push when no device has a live connection, to the phones that want this kind.
              if (r.clients.size === 0) {
                for (const { token, platform, app, kinds } of r.pushTokens.values()) {
                  if (!kinds || kinds.includes(kind)) void pushSender.send(token, platform, payload, app);
                }
              }
              return;
            }
            case 'dismiss': {
              if (typeof ctrl.tag !== 'string' || !TAG.test(ctrl.tag)) return;
              for (const c of r.clients.values()) safeSend(c, { type: 'dismiss', tag: ctrl.tag });
              for (const { token, platform, app, kinds } of r.pushTokens.values()) {
                if (platform === 'ios' && (!kinds || kinds.includes('needs-you'))) void pushSender.sendDismiss?.(token, ctrl.tag, app);
              }
              return;
            }
            case 'push-remove': {
              if (typeof ctrl.deviceId === 'string') {
                r.pushTokens.delete(ctrl.deviceId);
                for (const devices of r.activities.values()) devices.delete(ctrl.deviceId);
                r.cards.delete(ctrl.deviceId);
              }
              return;
            }
            case 'activity': {
              const tag = typeof ctrl.tag === 'string' ? ctrl.tag : '';
              const devices = r.activities.get(tag);
              if (!devices || !PHASES.has(ctrl.phase)) return;
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
          if (r.agent === socket) r.agent = null;
          for (const c of r.clients.values()) safeSend(c, { type: 'agent-offline' });
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
            if (validDevice && validToken && platform && (!owner || owner === cid)) {
              r.pushOwners.set(deviceId, cid);
              r.pushTokens.set(deviceId, {
                token,
                platform,
                ...(app ? { app } : {}),
                ...(kinds ? { kinds } : {}),
              });
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
