import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { isRfc1918IPv4, isTailscaleIPv4, LOCAL_RELAY_PORT, type LocalRelayStatus } from '@nekko-agent/shared';

/**
 * "Relay on this computer" (TASKS.md PH4): the desktop runs `apps/relay-server`
 * itself, bound to this computer's Tailscale address, so a phone on the same
 * tailnet reaches it over WireGuard with no hosted relay in between. It
 * replaces `scripts/private-relay.*`.
 *
 * Tailscale first: the relay runs only while Tailscale is up. Next to the
 * tailnet address it also listens on this computer's private LAN addresses
 * (RFC 1918 only; never 0.0.0.0, link-local or a public address), so a phone on
 * the same Wi-Fi reaches it without the tailnet (TASKS.md IO-20). That is on
 * by default and has its own switch. When Tailscale isn't up the card says so;
 * a switched-on relay keeps checking and starts when Tailscale comes back, and
 * moves when the tailnet or LAN addresses change.
 */

interface Saved {
  enabled: boolean;
  port: number;
  /** Listen on the LAN too. Saved only when switched off. */
  lan: boolean;
}

export interface LocalRelayDeps {
  /** Where the on/off switch and port are kept. */
  stateFile: string;
  /** The bundled relay entry (`out/main/relay.js`). */
  entry: string;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** This computer's MagicDNS name, if the Tailscale CLI is installed and up. */
  tailnetName?: () => Promise<string | undefined>;
  spawnRelay?: (entry: string, host: string, port: number, lan: string[]) => ChildProcess;
  /** How often a switched-on relay rechecks Tailscale. */
  watchMs?: number;
  startTimeoutMs?: number;
}

/** The first address in Tailscale's 100.64.0.0/10 range on any interface. */
export function tailnetAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | undefined {
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && isTailscaleIPv4(i.address)) return i.address;
    }
  }
  return undefined;
}

/**
 * This computer's private LAN addresses (RFC 1918 IPv4, not internal), in
 * interface order, without repeats: where the relay listens besides the tailnet.
 */
export function relayLanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && isRfc1918IPv4(i.address) && !out.includes(i.address)) out.push(i.address);
    }
  }
  return out;
}

/** The address phones dial: the MagicDNS name when known (Android needs one), else the tailnet IP. */
export function localRelayUrl(name: string | undefined, ip: string, port: number): string {
  return `ws://${name ?? ip}:${port}`;
}

const TAILSCALE_CLIS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];

/** `tailscale status --json` → `Self.DNSName`, without the trailing dot. */
export function magicDnsName(): Promise<string | undefined> {
  const attempt = (i: number): Promise<string | undefined> =>
    i >= TAILSCALE_CLIS.length
      ? Promise.resolve(undefined)
      : new Promise((done) => {
          execFile(TAILSCALE_CLIS[i], ['status', '--json'], { timeout: 3000, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => {
            if (err) return done(attempt(i + 1));
            try {
              const name = String(JSON.parse(out).Self?.DNSName ?? '').replace(/\.$/, '');
              done(name.endsWith('.ts.net') ? name : undefined);
            } catch {
              done(undefined);
            }
          });
        });
  return attempt(0);
}

function spawnBundledRelay(entry: string, host: string, port: number, lan: string[]): ChildProcess {
  return spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NEKKO_RELAY_HOST: host,
      NEKKO_RELAY_PORT: String(port),
      NEKKO_RELAY_LAN_HOSTS: lan.join(','),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export class LocalRelay {
  private saved: Saved;
  private child: ChildProcess | null = null;
  private boundIp: string | undefined;
  /** The LAN addresses asked for, and the ones the relay actually bound. */
  private askedLan: string[] = [];
  private boundLan: string[] = [];
  private boundPort = 0;
  private name: string | undefined;
  private error: string | undefined;
  private starting: Promise<void> | null = null;
  private naming: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  private readonly tailnetName: () => Promise<string | undefined>;
  private readonly spawnRelay: (entry: string, host: string, port: number, lan: string[]) => ChildProcess;

  constructor(private readonly deps: LocalRelayDeps) {
    this.interfaces = deps.interfaces ?? networkInterfaces;
    this.tailnetName = deps.tailnetName ?? magicDnsName;
    this.spawnRelay = deps.spawnRelay ?? spawnBundledRelay;
    this.saved = { enabled: false, port: LOCAL_RELAY_PORT, lan: true };
    try {
      const s = JSON.parse(readFileSync(deps.stateFile, 'utf8')) as Partial<Saved>;
      this.saved = { enabled: s.enabled === true, port: Number.isInteger(s.port) ? s.port! : LOCAL_RELAY_PORT, lan: s.lan !== false };
    } catch {
      // Never switched on.
    }
  }

  /** At app start: bring a switched-on relay back. */
  resume(): void {
    if (this.saved.enabled) void this.start();
  }

  status(): LocalRelayStatus {
    const ip = tailnetAddress(this.interfaces());
    // The MagicDNS name before the relay ever starts, so the address Remote
    // access offers as its default is the one Android can dial (TS-1).
    if (ip && !this.name && !this.naming) {
      this.naming = this.tailnetName()
        .then((n) => {
          this.name ??= n;
        })
        .catch(() => {});
    }
    const running = !!this.child && !!this.boundIp;
    const at = running ? this.boundIp : ip;
    return {
      available: true,
      running,
      enabled: this.saved.enabled,
      port: this.saved.port,
      tailnetIp: ip,
      tailnetName: this.name,
      url: at ? localRelayUrl(this.name, at, this.saved.port) : undefined,
      error: running ? undefined : this.error ?? (ip ? undefined : NO_TAILSCALE),
      lan: this.saved.lan,
      lanUrls: running ? this.boundLan.map((a) => `ws://${a}:${this.boundPort}`) : [],
    };
  }

  /** The LAN switch. A running relay restarts on the new set of addresses. */
  async setLan(on: boolean): Promise<LocalRelayStatus> {
    if (on !== this.saved.lan) this.save({ ...this.saved, lan: on });
    if (this.saved.enabled) await this.ensure();
    return this.status();
  }

  async start(): Promise<LocalRelayStatus> {
    if (!this.saved.enabled) this.save({ ...this.saved, enabled: true });
    this.watch();
    await this.ensure();
    return this.status();
  }

  async stop(): Promise<LocalRelayStatus> {
    this.save({ ...this.saved, enabled: false });
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.error = undefined;
    await this.kill();
    return this.status();
  }

  /** App shutdown: stop the process, keep the switch as it is. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.kill();
  }

  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.ensure(), this.deps.watchMs ?? 30_000);
    this.timer.unref?.();
  }

  /** Running on the current tailnet (and LAN) addresses, or a reason why not. */
  private ensure(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const ifaces = this.interfaces();
      const ip = tailnetAddress(ifaces);
      const lan = this.saved.lan ? relayLanAddresses(ifaces) : [];
      if (this.child && this.boundIp === ip && sameList(this.askedLan, lan)) return;
      await this.kill();
      if (!ip) {
        this.error = NO_TAILSCALE;
        return;
      }
      this.name = await this.tailnetName().catch(() => undefined);
      this.error = await this.launch(ip, lan);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private launch(ip: string, lan: string[]): Promise<string | undefined> {
    const port = this.saved.port;
    return new Promise((done) => {
      let settled = false;
      let stderr = '';
      const child = this.spawnRelay(this.deps.entry, ip, port, lan);
      const finish = (error?: string, ready?: Ready) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          child.kill();
        } else {
          this.child = child;
          this.boundIp = ip;
          this.askedLan = lan;
          this.boundPort = ready?.port || port;
          this.boundLan = (ready?.lan ?? []).filter((a) => lan.includes(a));
        }
        done(error);
      };
      const timeout = setTimeout(() => finish('The relay did not start in time.'), this.deps.startTimeoutMs ?? 10_000);
      child.stdout?.on('data', (d: Buffer) => {
        const ready = readyLine(String(d));
        if (ready) finish(undefined, ready);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += String(d);
      });
      child.on('error', (e) => finish(`The relay could not start: ${e.message}`));
      child.on('exit', () => {
        if (!settled) return finish(relayFailure(stderr, port));
        if (this.child === child) {
          this.child = null;
          this.boundIp = undefined;
          this.boundLan = [];
          this.error = 'The relay stopped unexpectedly. It restarts on its own while this is switched on.';
        }
      });
    });
  }

  private kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.boundIp = undefined;
    this.boundLan = [];
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((done) => {
      child.once('exit', () => done());
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 2000).unref?.();
    });
  }

  private save(next: Saved): void {
    this.saved = next;
    try {
      if (!existsSync(dirname(this.deps.stateFile))) mkdirSync(dirname(this.deps.stateFile), { recursive: true });
      const { lan, ...rest } = next;
      writeFileSync(this.deps.stateFile, JSON.stringify(lan ? rest : next));
    } catch {
      // The relay still works this session; it just won't come back by itself.
    }
  }
}

interface Ready {
  port?: number;
  lan: string[];
}

/**
 * `NEKKO_RELAY_READY {"port":N,"lan":[…]}`: the port and LAN addresses the
 * relay bound. Undefined without the marker; an unreadable payload reads as empty.
 */
export function readyLine(out: string): Ready | undefined {
  const at = out.indexOf('NEKKO_RELAY_READY');
  if (at < 0) return undefined;
  const m = out.slice(at).match(/^NEKKO_RELAY_READY (\{.*\})/);
  try {
    const r = m ? (JSON.parse(m[1]) as Partial<Ready>) : {};
    const port = r.port;
    return {
      port: Number.isInteger(port) && port! >= 0 && port! <= 65535 ? port : undefined,
      lan: Array.isArray(r.lan) ? r.lan.filter((a): a is string => typeof a === 'string') : [],
    };
  } catch {
    return { lan: [] };
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const NO_TAILSCALE = "Tailscale isn't connected on this computer. Install Tailscale and sign in, and the relay starts.";

export function relayFailure(stderr: string, port: number): string {
  const m = stderr.match(/NEKKO_RELAY_ERROR (\{.*\})/);
  let code: string | undefined;
  try {
    code = m ? (JSON.parse(m[1]) as { code?: string }).code : undefined;
  } catch {
    code = undefined;
  }
  if (code === 'EADDRINUSE') return `Port ${port} is already in use on this computer. Close whatever is using it (another relay?) and try again.`;
  if (code === 'EADDRNOTAVAIL') return 'The Tailscale address went away while the relay was starting. It retries on its own.';
  return 'The relay could not start.';
}

/** The bundled entry beside the backend in a build; tests pass their own. */
export function bundledRelayEntry(): string {
  return join(__dirname, 'relay.js');
}
