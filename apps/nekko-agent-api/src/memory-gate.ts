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

interface Waiter {
  weight: number;
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
   */
  acquire(weight: number, signal?: AbortSignal): Promise<() => void> {
    const w = Math.max(0, Math.floor(weight));
    // FIFO: nobody passes a waiter, so one big request is never starved by small ones.
    if (!this.queue.length && this.fits(w)) return Promise.resolve(this.take(w));
    if (this.queue.length >= this.maxQueued) return Promise.reject(new BusyError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        weight: w,
        admit: () => resolve(this.take(w)),
        fail: reject,
        timer: setTimeout(() => this.drop(waiter, new BusyError()), this.maxWaitMs),
      };
      waiter.timer.unref();
      signal?.addEventListener("abort", () => this.drop(waiter, new Error("aborted")), { once: true });
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

const releases = new WeakMap<FastifyRequest, (() => void)[]>();
const aborts = new WeakMap<FastifyRequest, AbortController>();

function abortFor(req: FastifyRequest): AbortController {
  let c = aborts.get(req);
  if (!c) aborts.set(req, (c = new AbortController()));
  return c;
}

/**
 * Hold `weight` bytes of the budget until this request's response is sent (or
 * the client goes away). Throws BusyError, which the error handler answers as
 * 503 busy.
 */
export async function holdMemory(app: FastifyInstance, req: FastifyRequest, weight: number): Promise<void> {
  const gate = app.memoryGate;
  if (!gate) return;
  const controller = abortFor(req);
  const release = await gate.acquire(weight, controller.signal);
  // Gone while it waited: give the room straight back.
  if (controller.signal.aborted) return release();
  const list = releases.get(req) ?? [];
  list.push(release);
  releases.set(req, list);
}

/** Bytes a page of stored blobs costs to send. */
export const pageWeight = (storedBytes: number) => storedBytes * PAGE_FACTOR;

declare module "fastify" {
  interface FastifyInstance {
    memoryGate?: MemoryGate;
  }
}

/**
 * Queue every request whose body is over SMALL_BODY_BYTES before Fastify reads
 * it, and release what each request held once its answer is out.
 */
export function registerMemoryGate(app: FastifyInstance, gate: MemoryGate): void {
  app.decorate("memoryGate", gate);
  app.addHook("onRequest", async (req) => {
    const length = Number(req.headers["content-length"] ?? 0);
    // A chunked body has no length: weigh it as its route's limit allows.
    const chunked = !req.headers["content-length"] && /chunked/i.test(String(req.headers["transfer-encoding"] ?? ""));
    const bytes = chunked ? req.routeOptions.bodyLimit ?? 0 : length;
    if (bytes > SMALL_BODY_BYTES) await holdMemory(app, req, bytes * BODY_FACTOR);
  });
  const releaseAll = async (req: FastifyRequest) => {
    for (const release of releases.get(req) ?? []) release();
    releases.delete(req);
  };
  app.addHook("onResponse", releaseAll);
  app.addHook("onRequestAbort", async (req) => {
    aborts.get(req)?.abort();
    await releaseAll(req);
  });
}
