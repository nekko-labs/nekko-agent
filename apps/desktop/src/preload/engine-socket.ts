import type { TerminalStream, TerminalStreamHandlers } from '@nekko-agent/shared';

/**
 * The preload's connection to the engine: one WebSocket carrying requests,
 * replies and events (`/api/ws`), plus one socket per open terminal
 * (`/api/term/:id`).
 *
 * This replaced `ipcRenderer.invoke`, which routed every call through the
 * Electron main process. Main no longer runs the engine, so a call now goes
 * straight from this renderer to the engine process, and a busy engine can no
 * longer hold up the window.
 */

export interface EngineEndpoint {
  url: string;
  token: string;
}

/** ipcRenderer-shaped, so the existing `on*` bridges needed no rewrite. */
export type Listener = (event: unknown, payload: any) => void;

interface Pending {
  channel: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const OP_INPUT = 0;
const OP_RESIZE = 1;
const OP_ACK = 2;

export interface EngineSocket {
  call(channel: string, args: unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  off(channel: string, listener: Listener): void;
  openTerminal(id: string, handlers: TerminalStreamHandlers): Promise<TerminalStream | null>;
  /**
   * Take the agent event stream of these chats only (null: every chat's).
   * Every chat's summary events still arrive (a turn starting, waiting,
   * ending; see crates/nekkod/src/hub.rs). Kept across reconnects.
   */
  subscribe(sessionIds: string[] | null): void;
}

/**
 * The heartbeat: a `daemon:ping` (answered by the socket itself, not the
 * router, so a slow call never delays it) every `pingMs`; a socket that has
 * sent nothing at all for `deadMs` is given up as a wedged engine, which
 * fails every call in flight and reconnects. Calls themselves have no
 * deadline, so a long one (a turn, a download) is never cut short while the
 * engine is alive.
 */
export interface HeartbeatOptions {
  pingMs?: number;
  deadMs?: number;
}

export const PING_CHANNEL = 'daemon:ping';
const PING_MS = 10_000;
const DEAD_MS = 30_000;

export function createEngineSocket(getEndpoint: (operation?: string) => Promise<EngineEndpoint | null>, heartbeat: HeartbeatOptions = {}): EngineSocket {
  const pingMs = heartbeat.pingMs ?? PING_MS;
  const deadMs = heartbeat.deadMs ?? DEAD_MS;
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let socket: WebSocket | null = null;
  let open = false;
  let queued: string[] = [];
  let endpoint: EngineEndpoint | null = null;
  let retry = 100;
  /** The chats whose stream this window takes; null for every chat. */
  let sessions: string[] | null = null;
  /** What the open socket was last told (or connected with). */
  let told: string | null = null;

  const wsBase = (e: EngineEndpoint) => e.url.replace(/^http/, 'ws');
  const key = (ids: string[] | null) => (ids ? [...ids].sort().join(',') : '*');

  const onFrame = (raw: string) => {
    let msg: { id?: number; result?: unknown; error?: string; channel?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result ?? null);
      return;
    }
    const set = msg.channel ? listeners.get(msg.channel) : undefined;
    set?.forEach((l) => l(undefined, msg.payload));
  };

  /** Tell the open socket which chats this window shows, if it changed. */
  const sendSubscription = () => {
    if (!open || !socket || !endpoint || told === key(sessions)) return;
    told = key(sessions);
    // Fire and forget: the reply carries nothing, and a replay (if any)
    // arrives before it as an `agent:replay` event.
    socket.send(JSON.stringify({ id: nextId++, channel: 'daemon:subscribe', args: [sessions] }));
  };

  const connect = async () => {
    try {
      endpoint = await getEndpoint([...pending.values()].map(p => p.channel).join(', ') || 'connection retry');
      if (!endpoint) throw new Error('Nekko service is stopped. Start it from the tray or developer controls.');
    } catch (e) {
      endpoint = null;
      queued = [];
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(e instanceof Error ? e : new Error('Nekko service is unavailable. Start it from the tray.'));
      }
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 2000);
      return;
    }
    // Narrowed from the start, so a reconnect is never sent every chat's
    // stream in between; the daemon then names the running turns of the chats
    // left out, and replays the ones named.
    const narrowed = sessions ? `sessions=${encodeURIComponent(sessions.join(','))}&` : '';
    const ws = new WebSocket(`${wsBase(endpoint)}/api/ws?${narrowed}token=${encodeURIComponent(endpoint.token)}`);
    socket = ws;
    // The URL already says which chats (none named: every chat).
    told = key(sessions);
    let heard = Date.now();
    let beat: ReturnType<typeof setInterval> | undefined;
    /** This socket is done: fail what it carried and connect again. */
    const lost = (why: string) => {
      clearInterval(beat);
      if (socket !== ws) return;
      open = false;
      socket = null;
      endpoint = null;
      queued = [];
      // A call in flight when the engine went away cannot be known to have
      // run or not; fail it plainly rather than replay it.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error(`${p.channel}: ${why}`));
      }
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 2000);
    };
    ws.onopen = () => {
      open = true;
      retry = 100;
      heard = Date.now();
      const out = queued;
      queued = [];
      out.forEach((f) => ws.send(f));
      sendSubscription();
      beat = setInterval(() => {
        if (socket !== ws) return clearInterval(beat);
        if (Date.now() - heard >= deadMs) {
          // Fail the calls now; a close handshake with a wedged engine may never finish.
          lost('the engine stopped responding before it answered');
          try { ws.close(); } catch { /* already closing */ }
          return;
        }
        ws.send(JSON.stringify({ id: nextId++, channel: PING_CHANNEL, args: [] }));
      }, pingMs);
    };
    ws.onmessage = (ev) => {
      heard = Date.now();
      onFrame(String(ev.data));
    };
    ws.onclose = () => lost('the engine restarted before it answered');
  };
  void connect();

  const send = (frame: string) => {
    if (open && socket) socket.send(frame);
    else queued.push(frame);
  };

  return {
    call(channel, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { channel, resolve, reject });
        send(JSON.stringify({ id, channel, args }));
      });
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
    },
    off(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
    subscribe(ids) {
      sessions = ids ? [...new Set(ids)] : null;
      sendSubscription();
    },
    async openTerminal(id, h) {
      const e = endpoint ?? (await getEndpoint(`terminal:${id}`));
      if (!e) return null;
      const ws = new WebSocket(`${wsBase(e)}/api/term/${encodeURIComponent(id)}?token=${encodeURIComponent(e.token)}`);
      ws.binaryType = 'arraybuffer';
      const outbox: Uint8Array<ArrayBuffer>[] = [];
      let closedByUs = false;
      const frame = (op: number, body: Uint8Array) => {
        const f = new Uint8Array(body.length + 1);
        f[0] = op;
        f.set(body, 1);
        if (ws.readyState === WebSocket.OPEN) ws.send(f);
        else if (ws.readyState === WebSocket.CONNECTING) outbox.push(f);
      };
      ws.onopen = () => outbox.splice(0).forEach((f) => ws.send(f));
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'hello') h.onHello?.(m);
            else if (m.type === 'exit') h.onExit?.(m.code ?? null);
          } catch {
            /* not a control frame we know */
          }
          return;
        }
        h.onData(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (!closedByUs) h.onClose?.();
      };
      const encoder = new TextEncoder();
      return {
        write: (data: string) => frame(OP_INPUT, encoder.encode(data)),
        resize: (cols: number, rows: number) => {
          const b = new Uint8Array(4);
          new DataView(b.buffer).setUint16(0, cols);
          new DataView(b.buffer).setUint16(2, rows);
          frame(OP_RESIZE, b);
        },
        ack: (bytes: number) => {
          const b = new Uint8Array(4);
          new DataView(b.buffer).setUint32(0, bytes >>> 0);
          frame(OP_ACK, b);
        },
        close: () => {
          closedByUs = true;
          ws.close();
        },
      };
    },
  };
}
