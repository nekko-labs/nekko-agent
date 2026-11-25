import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Request queueing by memory (issue #3342). The API runs on one small machine,
 * and a few big sync bodies or pages at once used to run it out of memory
 * (2026-11-25: OOM-killed by a burst of 24 MB pushes, then stalled for minutes
 * in garbage collection by overlapping 8 to 16 MB pulls). Every request that
 * carries or returns a big payload first takes its share of a memory budget;
 * when the budget is spent it waits in a FIFO queue. A queued upload is not
 * read yet, so its bytes stay in the socket, not in this process.
 *
 * A request that waits longer than `maxWaitMs`, or finds the queue full, gets
 * 503 `busy` with a Retry-After: the desktop and iPhone apps retry that on
 * their own (#3186, #3343).
 *
 * The budget follows the machine: it is the machine's memory less a fixed
 * reserve for the idle process, so `fly scale memory` widens it with no code
 * change. docs: apps/nekko-agent-api/README.md, "Memory".
 */

/** Memory this process needs before any payload: Node, Fastify, pg and the timers idle at about 92 MB RSS (measured on Fly, 2026-11-25). */
export const IDLE_RESERVE_BYTES = 112 * 1024 * 1024;
/** The smallest budget, so a tiny machine still admits one ordinary request at a time. */
export const MIN_BUDGET_BYTES = 32 * 1024 * 1024;
/**
 * Peak RSS per payload byte, measured with docs/perf-history.md's 2026-11-26 entry:
 * a 24 MB push body peaks at 63 MB (raw chunks, the string, the parsed JSON, the
 * decoded blobs); an 8 MB pull page at 50 MB and a 16 MB one at 94 MB (rows,
 * base64url strings, the JSON text, its write buffer), plus pg's own receive
 * buffer for the rows.
 */
export const BODY_FACTOR = 3;
export const PAGE_FACTOR = 7;
/** A request weighing at most this may pass the queue when it fits in the room left (see `acquire`). */
export const SKIP_AHEAD_BYTES = 2 * 1024 * 1024;
/** Bodies at or under this skip the queue: the common small calls never wait. */
export const SMALL_BODY_BYTES = 64 * 1024;

export interface MemoryGateOptions {
  /** Bytes of estimated peak memory that may be in flight at once. */
  budgetBytes: number;
  /** How long a request may wait for room before it is answered 503 busy. */
  maxWaitMs?: number;
  /** How many requests may wait at once; the next one is answered 503 busy straight away. */
  maxQueued?: number;
}

export class BusyError extends Error {
  statusCode = 503;
  constructor() {
    super("busy");
  }
}

/** The client went away while its request waited for room. Nobody reads the answer; 499 keeps it out of the error log and the 5xx alerts. */
export class AbortedError extends Error {
  statusCode = 499;
  constructor() {
    super("aborted");
  }
}

interface Waiter {
  weight: number;
  since: number;
  admit: () => void;
  fail: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class MemoryGate {
  readonly budgetBytes: number;
  private readonly maxWaitMs: number;
  private readonly maxQueued: number;
  private inFlight = 0;
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(opts: MemoryGateOptions) {
    this.budgetBytes = opts.budgetBytes;
    this.maxWaitMs = opts.maxWaitMs ?? 20_000;
    this.maxQueued = opts.maxQueued ?? 64;
  }

  /** What is in flight and waiting, for logs and tests. */
  get stats() {
    return { inFlightBytes: this.inFlight, running: this.running, queued: this.queue.length };
  }

  /**
   * Wait for room for `weight` bytes. Resolves with the release (call it once,
   * extra calls do nothing); rejects with BusyError. A weight larger than the
   * whole budget runs alone, once nothing else is in flight.
   *
   * The queue is FIFO, except that a small request that fits in the room left
   * right now goes ahead of the waiters: a 5 KB page never sits behind a queued
   * 16 MB one. To keep the head from starving, small requests stop passing once
   * it has waited half of `maxWaitMs`; after that the line is strict again.
   */
  acquire(weight: number, signal?: AbortSignal): Promise<() => void> {
    const w = Math.max(0, Math.floor(weight));
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (!this.queue.length && this.fits(w)) return Promise.resolve(this.take(w));
    if (this.queue.length && w <= SKIP_AHEAD_BYTES && this.inFlight + w <= this.budgetBytes && Date.now() - this.queue[0].since < this.maxWaitMs / 2) return Promise.resolve(this.take(w));
    if (this.queue.length >= this.maxQueued) return Promise.reject(new BusyError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        weight: w,
        since: Date.now(),
        admit: () => resolve(this.take(w)),
        fail: reject,
        timer: setTimeout(() => this.drop(waiter, new BusyError()), this.maxWaitMs),
      };
      waiter.timer.unref();
      signal?.addEventListener("abort", () => this.drop(waiter, new AbortedError()), { once: true });
      this.queue.push(waiter);
    });
  }

  private fits(w: number): boolean {
    return this.running === 0 || this.inFlight + w <= this.budgetBytes;
  }

  private take(w: number): () => void {
    this.inFlight += w;
    this.running++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight -= w;
      this.running--;
      this.pump();
    };
  }

  private drop(waiter: Waiter, e: Error): void {
    const i = this.queue.indexOf(waiter);
    if (i < 0) return;
    this.queue.splice(i, 1);
    clearTimeout(waiter.timer);
    waiter.fail(e);
    // The head may have been what held the rest back.
    this.pump();
  }

  private pump(): void {
    while (this.queue.length && this.fits(this.queue[0].weight)) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      next.admit();
    }
  }
}

/** The budget for this machine: its memory less the idle process. */
export function budgetForMachine(machineBytes = totalmem()): number {
  return Math.max(MIN_BUDGET_BYTES, machineBytes - IDLE_RESERVE_BYTES);
}

/** The numbers the startup log prints, and the warning when the heap cap is missing. */
export function memoryReport(budgetBytes: number, machineBytes = totalmem(), heapLimitBytes = getHeapStatistics().heap_size_limit) {
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  const heapShare = heapLimitBytes / machineBytes;
  return {
    line: `memory: machine ${mb(machineBytes)} MB, heap limit ${mb(heapLimitBytes)} MB (${Math.round(heapShare * 100)}%), request budget ${mb(budgetBytes)} MB`,
    // Node's default heap limit ignores the machine (259 MB on a 210 MB Fly machine): without
    // start.sh's cap V8 never collects hard enough and the kernel kills the process instead.
    warning: heapShare > 0.75
      ? `heap limit ${mb(heapLimitBytes)} MB is ${Math.round(heapShare * 100)}% of this machine's ${mb(machineBytes)} MB: start with start.sh (NODE_HEAP_PERCENT) so the heap is capped`
      : null,
  };
}

interface Held {
  releases: (() => void)[];
  /** The handler's answer is built (onSend ran): what is left is writing it. */
  built: boolean;
  /** The client closed before the response finished. */
  aborted: boolean;
}
const held = new WeakMap<FastifyRequest, Held>();
const aborts = new WeakMap<FastifyRequest, AbortController>();

function abortFor(req: FastifyRequest): AbortController {
  let c = aborts.get(req);
  if (!c) aborts.set(req, (c = new AbortController()));
  return c;
}

/** Has the client's connection gone? A handler checks this between awaits and stops building a page nobody will read. */
export const clientGone = (req: FastifyRequest): boolean => req.raw.socket.destroyed || abortFor(req).signal.aborted;

/** Throws AbortedError (499) when the client is gone. */
export function ensureClient(req: FastifyRequest): void {
  if (clientGone(req)) throw new AbortedError();
}

/**
 * Hold `weight` bytes of the budget until this request's response is sent. A
 * client that hangs up does not free it while the handler is still building
 * the answer: the work, and its memory, are still there, so the room is given
 * back when the handler finishes (or at once if it already had). Throws
 * BusyError, which the error handler answers as 503 busy.
 */
export async function holdMemory(app: FastifyInstance, req: FastifyRequest, weight: number): Promise<void> {
  const gate = app.memoryGate;
  if (!gate) return;
  const controller = abortFor(req);
  const release = await gate.acquire(weight, controller.signal);
  // Gone while it waited: give the room straight back.
  if (controller.signal.aborted) {
    release();
    throw new AbortedError();
  }
  const state = held.get(req) ?? { releases: [], built: false, aborted: false };
  state.releases.push(release);
  held.set(req, state);
}

/** Bytes a page of stored blobs costs to send. */
export const pageWeight = (storedBytes: number) => storedBytes * PAGE_FACTOR;

/**
 * What a request's body weighs on the gate, 0 for none. The declared
 * Content-Length is the client's word, so it is never trusted past the route's
 * body limit: a request that declares more is not weighed at all (Fastify
 * answers it 413 without reading it), and the weight is clamped to the limit.
 */
export function bodyWeight(req: FastifyRequest): number {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return 0;
  const limit = req.routeOptions.bodyLimit ?? 0;
  const declared = req.headers["content-length"];
  // A chunked body has no length: weigh it as its route's limit allows.
  const chunked = declared === undefined && /chunked/i.test(String(req.headers["transfer-encoding"] ?? ""));
  const length = chunked ? limit : Number(declared ?? 0);
  if (!Number.isFinite(length) || length <= SMALL_BODY_BYTES) return 0;
  if (limit && length > limit) return 0;
  return length * BODY_FACTOR;
}

declare module "fastify" {
  interface FastifyInstance {
    memoryGate?: MemoryGate;
  }
  interface FastifyContextConfig {
    /** The route takes its body's share of the memory budget itself, after authentication (see `gateAfterAuth`). */
    gateAfterAuth?: boolean;
  }
}

/**
 * Queue every request whose body is over SMALL_BODY_BYTES before Fastify reads
 * it, and release what each request held once its answer is out. Routes with
 * `config.gateAfterAuth` are weighed by their own preParsing hook instead, once
 * the caller is known and has passed the rate limit.
 */
export function registerMemoryGate(app: FastifyInstance, gate: MemoryGate): void {
  app.decorate("memoryGate", gate);
  app.addHook("onRequest", async (req) => {
    if (req.routeOptions.config?.gateAfterAuth) return;
    const weight = bodyWeight(req);
    if (weight) await holdMemory(app, req, weight);
  });
  const releaseAll = (req: FastifyRequest) => {
    for (const release of held.get(req)?.releases ?? []) release();
    held.delete(req);
  };
  app.addHook("onSend", async (req, _reply, payload) => {
    const state = held.get(req);
    if (state) {
      state.built = true;
      // The client already left: the answer will not be written, so nothing more holds memory.
      if (state.aborted) releaseAll(req);
    }
    return payload;
  });
  app.addHook("onResponse", async (req) => releaseAll(req));
  app.addHook("onRequestAbort", async (req) => {
    aborts.get(req)?.abort();
    const state = held.get(req);
    if (!state) return;
    state.aborted = true;
    // Still building the answer: keep the room until the handler stops.
    if (state.built) releaseAll(req);
  });
}
