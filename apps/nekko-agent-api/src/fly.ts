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

/** Each machine's disk, kept while it is stopped. */
export const DISK_GB = 20;

const machineOf = (ref: string) => encodeURIComponent(ref.split("~")[0]);

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
    // Some calls (DELETE, 204) answer with no body.
    const raw = await res.text();
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  /**
   * A Fly machine's root filesystem is rebuilt from the image on every start, so
   * the machine's data (paired devices, chats, settings) lives on its own volume.
   * Our ref is `<machine>~<volume>`; the routes treat it as opaque.
   */
  async create(spec: MachineSpec): Promise<{ ref: string }> {
    const vol = await this.call<{ id: string }>("POST", "/volumes", {
      name: spec.name.replace(/[^a-z0-9]/g, "_").slice(0, 30),
      region: spec.region,
      size_gb: DISK_GB,
      encrypted: true,
    });
    const made = await this.call<{ id: string }>("POST", "/machines", {
      name: spec.name,
      region: spec.region,
      config: {
        image: spec.image,
        env: spec.env,
        guest: GUESTS[spec.size],
        mounts: [{ volume: vol.id, path: "/data" }],
        // Stopped when idle by the machine itself; restarted on the next chat. Never auto-destroyed.
        auto_destroy: false,
        restart: { policy: "on-failure", max_retries: 3 },
        // No public services: the machine only dials out, to the relay and its providers.
        services: [],
        metadata: { nekko: "cloud-machine" },
      },
    }).catch(async (e) => {
      await this.gone("DELETE", `/volumes/${encodeURIComponent(vol.id)}`).catch(() => {});
      throw e;
    });
    return { ref: `${made.id}~${vol.id}` };
  }

  async stop(ref: string): Promise<void> {
    await this.call("POST", `/machines/${machineOf(ref)}/stop`, {});
  }

  async start(ref: string): Promise<void> {
    await this.call("POST", `/machines/${machineOf(ref)}/start`, {});
  }

  /** A call where 404 (already gone) counts as done. */
  private async gone(method: string, path: string): Promise<void> {
    try {
      await this.call(method, path);
    } catch (e) {
      if (!String(e).includes(": 404")) throw e;
    }
  }

  /**
   * The machine, then its volume, which Fly refuses to delete while still
   * attached. A machine or volume Fly no longer has (404) counts as destroyed,
   * so a failed half is finished on the next try.
   */
  async destroy(ref: string): Promise<void> {
    const machine = machineOf(ref);
    await this.gone("DELETE", `/machines/${machine}?force=true`);
    const volume = ref.split("~")[1];
    if (!volume) return;
    await this.call("GET", `/machines/${machine}/wait?state=destroyed&timeout=25`).catch(() => {});
    await this.gone("DELETE", `/volumes/${encodeURIComponent(volume)}`);
  }

  async state(ref: string): Promise<LiveState> {
    try {
      const m = await this.call<{ state?: string; events?: { type?: string; timestamp?: number }[] }>("GET", `/machines/${machineOf(ref)}`);
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
