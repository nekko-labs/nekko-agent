/**
 * Relay v2 client: the phone side of the computer's relay agent (`crates/nekko-remote`).
 *
 * Connects to the relay as `role=client`, completes the sealed HELLO handshake
 * (device id + optional one-time pairing code), then speaks the host's own
 * request protocol: `{type:'req', id, channel, args}` out, `{type:'res'}` and
 * `{type:'event', channel, payload}` back, all E2E-sealed. Reconnects with
 * backoff until closed. Pure TS with an injectable WebSocket so it runs under
 * Node in tests and against a real relay in `scripts/itest-relay-mobile.mjs`.
 */
import { open, seal, type RandomBytes } from './e2e';

export type RelayState =
  /** Not started, or closed by the app. */
  | 'idle'
  /** Dialing the relay, or waiting for the agent's welcome. */
  | 'connecting'
  /** Welcomed by the agent; requests flow. */
  | 'online'
  /** Relay reachable but the computer isn't connected to it (asleep, app closed). */
  | 'offline'
  /** The computer refused this device (revoked, expired code). Terminal. */
  | 'denied';

export type DenyReason = 'unknown-device' | 'revoked' | 'bad-code' | 'invalid' | 'kicked' | 'bad-key';

export interface WelcomedDevice {
  id: string;
  name: string;
  platform: string;
}

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export interface RelayClientOptions {
  relayUrl: string;
  room: string;
  /** Pairing secret: relay transport auth (the relay hashes it; never decrypts). */
  key: string;
  /** AES key derived from (key, room); see e2e.deriveKeyBytes. */
  keyBytes: Uint8Array;
  deviceId: string;
  deviceName: string;
  platform: 'ios' | 'android' | 'web';
  /** One-time enrollment code from the QR; dropped once welcomed. */
  pairCode?: string;
  WebSocketImpl?: new (url: string) => WsLike;
  random?: RandomBytes;
  requestTimeoutMs?: number;
  onState?: (state: RelayState, detail?: string) => void;
  onEvent?: (channel: string, payload: unknown) => void;
  onWelcome?: (device: WelcomedDevice) => void;
  onDenied?: (reason: DenyReason) => void;
}

const OPEN = 1;

export class RelayClient {
  private ws: WsLike | null = null;
  private state: RelayState = 'idle';
  private welcomed = false;
  private stopped = true;
  private nextId = 1;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pairCode?: string;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly waiters = new Set<() => void>();

  constructor(private readonly opts: RelayClientOptions) {
    this.pairCode = opts.pairCode;
  }

  get current(): RelayState {
    return this.state;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.retry = 0;
    this.dial();
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.ws?.close(1000, 'closed by app');
    } catch {
      /* already closing */
    }
    this.ws = null;
    this.welcomed = false;
    this.failPending('disconnected');
    this.setState('idle');
  }

  /** Reconnect now instead of waiting out the backoff (app foregrounded). */
  nudge(): void {
    if (this.stopped || this.state === 'denied' || this.state === 'online') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = 0;
    if (!this.ws || this.ws.readyState !== OPEN) this.dial();
  }

  /** Call a host IPC channel. Waits (briefly) for the handshake if needed. */
  call<T = any>(channel: string, ...args: unknown[]): Promise<T> {
    return this.callWithTimeout<T>(120_000, channel, ...args);
  }

  /**
   * Same as call() with an explicit reply timeout. `chat:send` only replies
   * when the whole turn is over, so it gets hours rather than two minutes.
   */
  async callWithTimeout<T = any>(timeoutMs: number, channel: string, ...args: unknown[]): Promise<T> {
    await this.ready(this.opts.requestTimeoutMs ?? 15_000);
    const id = this.nextId++;
    const frame = seal(this.opts.keyBytes, { type: 'req', id, channel, args }, this.opts.random);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${channel}: timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ enc: frame }));
    });
  }

  /** Hand the relay this phone's push token (content-free "finished" pings). */
  async registerPush(token: string, platform: 'ios' | 'android'): Promise<void> {
    await this.ready(15_000);
    this.ws?.send(JSON.stringify({ type: 'register-push', token, platform, deviceId: this.opts.deviceId }));
  }

  private ready(timeoutMs: number): Promise<void> {
    if (this.welcomed && this.ws?.readyState === OPEN) return Promise.resolve();
    if (this.state === 'denied') return Promise.reject(new Error('This phone is no longer paired.'));
    if (this.stopped) return Promise.reject(new Error('Not connected.'));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new Error(this.state === 'offline' ? 'Your computer is offline.' : 'Could not reach your computer.'));
      }, timeoutMs);
      this.waiters.add(done);
    });
  }

  private dial(): void {
    if (this.stopped) return;
    this.welcomed = false;
    this.setState('connecting');
    const Impl = this.opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const url =
      `${this.opts.relayUrl.replace(/\/$/, '')}/relay?role=client` +
      `&room=${encodeURIComponent(this.opts.room)}&key=${encodeURIComponent(this.opts.key)}`;
    let ws: WsLike;
    try {
      ws = new Impl(url);
    } catch (e) {
      this.scheduleRetry((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.hello();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      /* onclose follows with the code */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      this.failPending('connection lost');
      if (this.stopped || this.state === 'denied') return;
      if (ev.code === 4001) return this.deny('kicked');
      if (ev.code === 1008 && /bad pairing key/i.test(ev.reason ?? '')) return this.deny('bad-key');
      if (ev.code === 1008 && /agent offline/i.test(ev.reason ?? '')) {
        this.setState('offline');
        this.scheduleRetry(undefined, true);
        return;
      }
      this.scheduleRetry(ev.reason || `closed (${ev.code})`);
    };
  }

  private hello(): void {
    const { deviceId, deviceName, platform } = this.opts;
    this.send({ type: 'hello', deviceId, name: deviceName, platform, ...(this.pairCode ? { pair: this.pairCode } : {}) });
  }

  private send(frame: unknown): void {
    if (this.ws?.readyState !== OPEN) return;
    this.ws.send(JSON.stringify({ enc: seal(this.opts.keyBytes, frame, this.opts.random) }));
  }

  private onMessage(raw: unknown): void {
    let env: any;
    try {
      env = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (typeof env?.enc === 'string') {
      let frame: any;
      try {
        frame = open(this.opts.keyBytes, env.enc);
      } catch {
        return; // wrong key or tampered: drop silently, like the agent does
      }
      this.onFrame(frame);
      return;
    }
    if (env?.type === 'agent-offline') {
      this.welcomed = false;
      this.setState('offline');
    } else if (env?.type === 'agent-online' && !this.welcomed) {
      // The computer (re)joined after us: repeat the handshake.
      this.setState('connecting');
      this.hello();
    }
  }

  private onFrame(frame: any): void {
    switch (frame?.type) {
      case 'welcome':
        this.welcomed = true;
        this.pairCode = undefined; // enrollment done; never resend the code
        this.retry = 0;
        this.setState('online');
        this.opts.onWelcome?.(frame.device);
        for (const w of [...this.waiters]) w();
        return;
      case 'denied':
        this.deny(frame.reason ?? 'invalid');
        return;
      case 'res': {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.error) p.reject(new Error(String(frame.error)));
        else p.resolve(frame.result);
        return;
      }
      case 'event':
        this.opts.onEvent?.(frame.channel, frame.payload);
        return;
    }
  }

  private deny(reason: DenyReason): void {
    this.welcomed = false;
    this.stopped = true;
    this.failPending('This phone is no longer paired.');
    try {
      this.ws?.close(1000);
    } catch {
      /* closing */
    }
    this.ws = null;
    this.setState('denied', reason);
    this.opts.onDenied?.(reason);
  }

  private scheduleRetry(detail?: string, offline = false): void {
    if (this.stopped) return;
    if (!offline) this.setState('connecting', detail);
    // 1s, 2s, 4s … capped at 30s; an offline computer is polled at the cap.
    const delay = offline ? 15_000 : Math.min(30_000, 1000 * 2 ** this.retry++);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.dial();
    }, delay);
  }

  private failPending(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private setState(state: RelayState, detail?: string): void {
    if (state === this.state && !detail) return;
    this.state = state;
    this.opts.onState?.(state, detail);
  }
}
