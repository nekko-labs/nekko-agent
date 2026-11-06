/**
 * Where a Nekko Cloud machine runs. `MachineDriver` is the few calls the
 * machines routes make; `FlyDriver` is the one we run (the Fly Machines API,
 * one microVM per machine, no public IP), `MemoryDriver` stands in for tests.
 */

export interface MachineSpec {
  /** A name for the hosting provider's console only. */
  name: string;
  /** A three-letter Fly region, e.g. `nrt`. */
  region: string;
  /** The image to run: nekkod and the Local Web UI in relay-agent mode. */
  image: string;
  /** The machine's environment: relay room, key, pairing code, scope. Never logged. */
  env: Record<string, string>;
  /** Guest size. */
  size: "small";
}

export interface MachineDriver {
  create(spec: MachineSpec): Promise<{ ref: string }>;
  stop(ref: string): Promise<void>;
  start(ref: string): Promise<void>;
  destroy(ref: string): Promise<void>;
  /** The provider's word for its state, mapped to ours, and when a stopped machine stopped, if it says. */
  state(ref: string): Promise<LiveState>;
}

export interface LiveState {
  state: "running" | "stopped" | "gone";
  stoppedAt?: Date;
}

export const GUESTS: Record<MachineSpec["size"], { cpu_kind: string; cpus: number; memory_mb: number }> = {
  small: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
};

export interface FlyOptions {
  token: string;
  /** The Fly app that holds every user machine, e.g. `nekko-cloud-machines`. */
  app: string;
  /** Fly's API; overridable for tests. */
  api?: string;
  fetch?: typeof fetch;
}

/** The Fly Machines API (https://fly.io/docs/machines/api/). */
export class FlyDriver implements MachineDriver {
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FlyOptions) {
    this.api = (opts.api ?? "https://api.machines.dev").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}/v1/apps/${this.opts.app}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // Fly's error bodies name the request, never our env; the token is never in them.
      const text = await res.text().catch(() => "");
      throw new Error(`Fly ${method} ${path}: ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async create(spec: MachineSpec): Promise<{ ref: string }> {
    const made = await this.call<{ id: string }>("POST", "/machines", {
      name: spec.name,
      region: spec.region,
      config: {
        image: spec.image,
        env: spec.env,
        guest: GUESTS[spec.size],
        // Stopped when idle by the machine itself; restarted on the next chat. Never auto-destroyed.
        auto_destroy: false,
        restart: { policy: "on-failure", max_retries: 3 },
        // No public services: the machine only dials out, to the relay and its providers.
        services: [],
        metadata: { nekko: "cloud-machine" },
      },
    });
    return { ref: made.id };
  }

  async stop(ref: string): Promise<void> {
    await this.call("POST", `/machines/${encodeURIComponent(ref)}/stop`, {});
  }

  async start(ref: string): Promise<void> {
    await this.call("POST", `/machines/${encodeURIComponent(ref)}/start`, {});
  }

  /** A machine Fly no longer has (404) counts as destroyed. */
  async destroy(ref: string): Promise<void> {
    try {
      await this.call("DELETE", `/machines/${encodeURIComponent(ref)}?force=true`);
    } catch (e) {
      if (!String(e).includes(": 404")) throw e;
    }
  }

  async state(ref: string): Promise<LiveState> {
    try {
      const m = await this.call<{ state?: string; events?: { type?: string; timestamp?: number }[] }>("GET", `/machines/${encodeURIComponent(ref)}`);
      if (m.state === "started") return { state: "running" };
      if (m.state === "destroyed") return { state: "gone" };
      // The newest exit or stop event: when the machine stopped itself (idle) or was stopped.
      const at = Math.max(0, ...(m.events ?? []).filter((e) => e.type === "exit" || e.type === "stop").map((e) => Number(e.timestamp) || 0));
      return at ? { state: "stopped", stoppedAt: new Date(at) } : { state: "stopped" };
    } catch (e) {
      if (String(e).includes(": 404")) return { state: "gone" };
      throw e;
    }
  }
}

/** Machines that exist only in memory: what the tests run against. */
export class MemoryDriver implements MachineDriver {
  readonly machines = new Map<string, { spec: MachineSpec; state: LiveState["state"]; stoppedAt?: Date }>();
  private next = 1;

  async create(spec: MachineSpec): Promise<{ ref: string }> {
    const ref = `m-${this.next++}`;
    this.machines.set(ref, { spec, state: "running" });
    return { ref };
  }
  async stop(ref: string): Promise<void> {
    const m = this.machines.get(ref);
    if (m) Object.assign(m, { state: "stopped", stoppedAt: new Date() });
  }
  async start(ref: string): Promise<void> {
    const m = this.machines.get(ref);
    if (m) m.state = "running";
  }
  async destroy(ref: string): Promise<void> {
    const m = this.machines.get(ref);
    if (m) m.state = "gone";
  }
  async state(ref: string): Promise<LiveState> {
    const m = this.machines.get(ref);
    return m ? { state: m.state, stoppedAt: m.state === "stopped" ? m.stoppedAt : undefined } : { state: "gone" };
  }
}
