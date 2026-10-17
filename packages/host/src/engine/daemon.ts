import { readDaemonResponse } from './daemon-response.js';
/**
 * The engine daemon's model-server channels (`crates/nekko-infer`), seen from
 * the TS engine.
 *
 * When this host runs as the desktop app's backend under `nekkod`, the daemon
 * owns every model-server process and the OpenAI-compatible port; the TS
 * engine keeps choosing what to load and with which arguments, and asks the
 * daemon to run it. Absent in the web and server editions, where
 * `server.ts` still spawns and proxies itself.
 */

export interface DaemonSpawnSpec {
  modelId: string;
  bin: string;
  /** With `{port}` where the listening port goes; the daemon picks the port. */
  args: string[];
  env?: Record<string, string>;
  kind: 'chat' | 'image';
  /** GET this path; a 200 means ready. */
  healthPath: string;
  /** And the body must contain this, when set. */
  healthExpect?: string;
  budgetSecs?: number;
}

export type DaemonSpawnOutcome =
  | { status: 'ready'; port: number; pid: number }
  | { status: 'failed'; message: string; log: string[] };

export interface DaemonChild {
  modelId: string;
  kind: 'chat' | 'image';
  port: number;
  pid: number;
  startedAt: number;
  lastUsedAt: number;
  activeRequests: number;
}

export interface EngineDaemon {
  serve(cfg: { port: number; host: string; apiKey?: string; corsOrigins: string[] }): Promise<{ ok: boolean; message: string }>;
  stopServing(): Promise<void>;
  /** The configuration the router is listening with, or null when it is not. */
  serving(): Promise<{ port: number; host: string } | null>;
  spawn(spec: DaemonSpawnSpec): Promise<DaemonSpawnOutcome>;
  kill(modelId: string): Promise<boolean>;
  list(): Promise<DaemonChild[]>;
  /** Load a Laya model dir into the daemon's decision runtime (`crates/nekko-decide`). */
  /** `directml`: a DirectML.dll the host downloaded, for a Windows whose own copy is too old. */
  decideLoad(req: { dir: string; precision?: string; name?: string; directml?: string }): Promise<Record<string, unknown>>;
  decideUnload(): Promise<void>;
  decideStatus(): Promise<Record<string, unknown>>;
  decideRun(request: import('@nekko-agent/shared').DecisionRequest): Promise<Omit<import('@nekko-agent/shared').DecisionResponse, 'provider' | 'latencyMs'>>;
}

/** Where `{port}` goes in a daemon spawn's arguments. */
export const DAEMON_PORT = '{port}';

let current: EngineDaemon | undefined;
let currentLink: { url: string; token: string } | undefined;

/** Hand the model servers to the engine daemon (desktop backend under nekkod). */
export function useEngineDaemon(link: { url: string; token: string } | null): void {
  current = link ? daemonClient(link) : undefined;
  currentLink = link ?? undefined;
}

/** Where the daemon this host runs under listens, and its token; undefined without one. */
export function daemonLink(): { url: string; token: string } | undefined {
  return currentLink;
}

/**
 * Call any daemon channel, when this host runs under the daemon (the desktop
 * backend); undefined in the web and server editions.
 */
export function daemonCall(): (<T>(channel: string, ...args: unknown[]) => Promise<T>) | undefined {
  const link = currentLink;
  if (!link) return undefined;
  return async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const res = await fetch(`${link.url}/api/${channel}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    return readDaemonResponse<T>(res, channel);
  };
}

/**
 * Whether the daemon this host runs under owns `what` (a file it is the
 * single writer of, such as `settings`), from `NEKKOD_OWNS`, which nekkod sets
 * when it knows the data directory.
 */
export function daemonOwns(what: string): boolean {
  return Boolean(currentLink) && (process.env.NEKKOD_OWNS ?? '').split(',').includes(what);
}

export function engineDaemon(): EngineDaemon | undefined {
  return current;
}

export function daemonClient(link: { url: string; token: string }): EngineDaemon {
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const res = await fetch(`${link.url}/api/${channel}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    return readDaemonResponse<T>(res, channel);
  };
  return {
    serve: (cfg) =>
      call<{ ok: boolean; message: string }>('infer:serve', cfg).catch((e: Error) => ({ ok: false, message: e.message })),
    stopServing: () => call('infer:stopServing'),
    serving: () => call('infer:serving'),
    spawn: (spec) => call('infer:spawn', spec),
    kill: (modelId) => call('infer:kill', modelId),
    list: () => call('infer:list'),
    decideLoad: (req) => call('decide:load', req),
    decideUnload: () => call('decide:unload'),
    decideStatus: () => call('decide:status'),
    decideRun: (request) => call('decide:run', request),
  };
}
