/**
 * CI runners (T213): the TypeScript mirror of what nekkod's `runner:*`
 * channels serialize (crates/nekkod/src/runner, crates/nekko-runner), the copy
 * the Workflows tab shows for it, and the pure helpers behind that copy. The
 * Rust shapes win: `runners.test.ts` reads the crate's fixtures so drift fails.
 */

export type Priority = 'doNotDisturb' | 'balanced' | 'runnerFirst';
export type KeepAwake = 'systemDefault' | 'whileActive' | 'always';
export type Scope = { kind: 'org'; org: string } | { kind: 'repo'; owner: string; repo: string };

export interface RunnerSettings {
  enabled: boolean;
  priority: Priority;
  keepAwake: KeepAwake;
  macosSlots: number;
  linuxSlots: number;
  memoryPerVmMb: number;
  /** Null: the daemon picks from the Mac's RAM. */
  runnerMemoryMb: number | null;
  /** Null: the daemon picks from the Mac's cores. */
  cpusPerVm: number | null;
  diskBudgetGb: number;
  diskFloorGb: number;
  maxJobMinutes: number;
  onlyOnPower: boolean;
  trustedNetworksOnly: boolean;
  neverOnHotspot: boolean;
  allowDirectWithVpn: boolean;
  allowForkPrs: boolean;
  rerunLostJobs: boolean;
  trustedCache: boolean;
  trustedNetworks: string[];
}

export interface RunnerConfig {
  id: string;
  scope: Scope;
  label: string;
  settings: RunnerSettings;
}

export type Reason =
  | 'off' | 'pausedAll' | 'schedule' | 'onBattery' | 'lowPowerMode' | 'network' | 'hotspot'
  | 'vpnCarriesAllTraffic' | 'memoryWarning' | 'memoryCritical' | 'thermalSerious' | 'thermalCritical'
  | 'diskFloor' | 'securityUpdate' | 'memoryHeadroom' | 'hostStateUnknown' | 'userActive' | 'userBusy';
export type SlotLimit = 'appleCap' | 'otherApps' | 'memory';
export type RunnerState = 'off' | 'waiting' | 'ready' | 'running' | 'draining' | 'cleaning' | 'error';
export type SlotState = 'starting' | 'ready' | 'running' | 'draining' | 'cleaning';

export interface JobRef { repo: string; runId: number; jobId: number; workflow: string; job: string }
export interface SlotView {
  state: SlotState;
  job: JobRef | null;
  /** Unix seconds the slot entered `state`. */
  since: number;
  drainEndsAt: number | null;
}
export interface Today { jobs: number; seconds: number }
/** The Mac's facts; all zeros with no VM support or before the first sample. */
export interface HostView {
  ramMb: number;
  cores: number;
  recommendedMemoryMb: number;
  runnerMemoryMb: number;
  cpusPerVm: number;
  onBattery: boolean | null;
  batteryPct: number | null;
  networkId: string | null;
  networkTrusted: boolean;
}
export type AuditResult = 'finished' | 'stopped' | 'lost' | 'failedToStart' | 'notRemoved';
export interface AuditLine {
  ts: number;
  runnerId: string;
  repo: string | null;
  workflow: string | null;
  job: string | null;
  result: AuditResult;
  seconds: number;
  /** `Reason` names, or the daemon's own (`slept`, `maxJobTime`, ...). */
  reason: string[];
}
export interface RunnerView {
  config: RunnerConfig;
  state: RunnerState;
  slots: SlotView[];
  reasons: Reason[];
  available: number;
  limit: SlotLimit | null;
  awake: boolean;
  error: string | null;
  today: Today;
  host: HostView;
  /** Newest first. */
  recent: AuditLine[];
}
export type ConnectRequest = GithubConnectRequest | GitlabConnectRequest;
export interface GithubConnectRequest {
  provider: 'github';
  scope: Scope;
  appId: number;
  installationId: number;
  /** Omitted to reuse the key the daemon already stores. */
  privateKeyPem?: string;
  repos: string[];
  allowPublic: boolean;
  label?: string;
}
/** A GitLab project (repo scope, `owner` may hold subgroups) or group (org scope). */
export interface GitlabConnectRequest {
  provider: 'gitlab';
  scope: Scope;
  /** The instance origin; omitted for https://gitlab.com. */
  baseUrl?: string;
  /** Omitted to reuse the token stored for this instance and scope. */
  accessToken?: string;
  /** Org scope: 1 to 20 full project paths inside the group. */
  projects?: string[];
  allowPublic?: boolean;
  /** Only jobs of protected branches and tags; the daemon defaults to true. */
  protectedOnly?: boolean;
  label?: string;
}

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  enabled: false,
  priority: 'doNotDisturb',
  keepAwake: 'whileActive',
  macosSlots: 1,
  linuxSlots: 0,
  memoryPerVmMb: 8192,
  runnerMemoryMb: null,
  cpusPerVm: null,
  diskBudgetGb: 150,
  diskFloorGb: 25,
  maxJobMinutes: 120,
  onlyOnPower: true,
  trustedNetworksOnly: true,
  neverOnHotspot: true,
  allowDirectWithVpn: false,
  allowForkPrs: false,
  rerunLostJobs: true,
  trustedCache: true,
  trustedNetworks: [],
};
export const DEFAULT_RUNNER_LABEL = 'nekko-cloud-mac';
export const MAX_MACOS_SLOTS = 2;
export const MAX_JOB_CHOICES = [30, 60, 120, 360];

export const PRIORITY_LABELS: Record<Priority, string> = {
  doNotDisturb: "Do not disturb: Only run when I'm idle",
  balanced: 'Balanced: in the background',
  runnerFirst: 'Runner first',
};
export const PRIORITY_DESCRIPTIONS: Record<Priority, string> = {
  doNotDisturb: "Only when you're away and plugged in. Steps aside the moment you need the Mac.",
  balanced: "Takes jobs while you work if there's headroom. Keeps one VM ready.",
  runnerFirst: "For a docked Mac that mostly runs CI. All slots ready, jobs finish even when you're busy.",
};
export const KEEP_AWAKE_LABELS: Record<KeepAwake, string> = {
  systemDefault: 'System default',
  whileActive: 'While a runner is active',
  always: 'Always',
};
export const VPN_DIRECT_LABEL = 'Let jobs use the internet directly while a VPN is on';

/** `short` reads after "Waiting: "; `sentence` stands alone. Keys in the Rust declaration order. */
export const REASONS: Record<Reason, { short: string; sentence: string }> = {
  off: { short: 'the runner is off', sentence: 'The runner is off.' },
  pausedAll: { short: 'automations are paused', sentence: 'All automations are paused.' },
  schedule: { short: 'outside your hours', sentence: 'It is outside the hours you allowed.' },
  onBattery: { short: 'on battery', sentence: 'This Mac is on battery, below what this mode allows.' },
  lowPowerMode: { short: 'Low Power Mode is on', sentence: 'Low Power Mode is on.' },
  network: { short: 'not a trusted network', sentence: 'This network is not one you trust. Add it in runner settings.' },
  hotspot: { short: 'on a hotspot', sentence: 'This Mac is on a hotspot or a metered network.' },
  vpnCarriesAllTraffic: {
    short: 'a VPN carries all traffic',
    sentence: `A VPN carries all of this Mac's traffic. Turn on "${VPN_DIRECT_LABEL}" to take jobs anyway.`,
  },
  memoryWarning: { short: 'memory is tight', sentence: 'Memory is under pressure.' },
  memoryCritical: { short: 'memory is critically low', sentence: 'Memory is critically low, so any running VM was stopped.' },
  thermalSerious: { short: 'the Mac is hot', sentence: 'This Mac is running hot.' },
  thermalCritical: { short: 'the Mac is too hot', sentence: 'This Mac is too hot, so any running VM was stopped.' },
  diskFloor: { short: 'free disk is low', sentence: 'Free disk is below the floor you set.' },
  securityUpdate: {
    short: 'a security update is waiting',
    sentence: 'A macOS security update has waited more than 7 days. Update this Mac to take jobs again.',
  },
  memoryHeadroom: { short: 'not enough free memory', sentence: 'There is not enough free memory for another VM right now.' },
  hostStateUnknown: { short: 'still reading this Mac', sentence: "Still reading this Mac's state. No new VM starts until it is known." },
  userActive: { short: "you're using the Mac", sentence: "You're using the Mac." },
  userBusy: { short: 'your apps are busy', sentence: 'Your apps are using most of the CPU.' },
};
export const SLOT_LIMITS: Record<SlotLimit, string> = {
  appleCap: 'Apple allows 2 macOS VMs per Mac.',
  otherApps: 'Another app is running a macOS VM.',
  memory: 'Not enough runner memory for another VM.',
};
export const STATE_LABELS: Record<RunnerState, string> = {
  off: 'Off', waiting: 'Waiting', ready: 'Ready', running: 'Running', draining: 'Draining', cleaning: 'Cleaning', error: 'Error',
};

const own = <T extends object>(o: T, k: string): k is Extract<keyof T, string> => Object.prototype.hasOwnProperty.call(o, k);

/** A newer daemon may send a reason this build does not know: never throw. */
export function reasonText(r: string): { short: string; sentence: string } {
  return own(REASONS, r) ? REASONS[r] : { short: 'a condition is not met', sentence: 'A condition is not met.' };
}

export function slotLimitText(l: string | null): string {
  return l !== null && own(SLOT_LIMITS, l) ? SLOT_LIMITS[l] : 'Fewer slots are available right now.';
}

export function scopeName(s: Scope): string {
  return s.kind === 'org' ? s.org : `${s.owner}/${s.repo}`;
}

export function formatMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return 'under 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function todayText(t: Today): string {
  return t.jobs ? `${t.jobs} ${t.jobs === 1 ? 'job' : 'jobs'} · ${formatMinutes(t.seconds)}` : 'No jobs yet';
}

export function runnerTitle(v: RunnerView): string {
  return `This Mac · GitHub · ${scopeName(v.config.scope)}`;
}

export function runnerSubtitle(v: RunnerView): string {
  const { scope, label, settings } = v.config;
  return `${scope.kind} scope · label ${label} · ${PRIORITY_LABELS[settings.priority]} · ${KEEP_AWAKE_LABELS[settings.keepAwake]}`;
}

export interface SlotLine { title: string; text: string; progress: number; dim: boolean }

/** One tile per configured macOS slot; slots past what the Mac allows are greyed with the bound's sentence. */
export function slotLines(v: RunnerView, nowSecs: number): SlotLine[] {
  const { macosSlots, maxJobMinutes } = v.config.settings;
  return Array.from({ length: macosSlots }, (_, i) => {
    const title = `Slot ${i + 1} · macOS`;
    const s = v.slots[i];
    if (!s) {
      if (i >= v.available) return { title, text: `Not available: ${slotLimitText(v.limit)}`, progress: 0, dim: true };
      const text = v.state === 'error' ? 'Stopped until the error above is fixed'
        : v.reasons.length ? `Waiting: ${reasonText(v.reasons[0]).short}` : 'Starts a VM when a job is queued';
      return { title, text, progress: 0, dim: false };
    }
    const elapsed = Math.max(0, nowSecs - s.since);
    const line = (text: string, progress = 0): SlotLine => ({ title, text, progress, dim: false });
    switch (s.state) {
      case 'starting': return line('Starting a VM');
      case 'ready': return line('Ready for a job');
      case 'running':
        return line(
          s.job ? `${s.job.workflow} · ${s.job.job} · ${formatMinutes(elapsed)}` : `Running a job · ${formatMinutes(elapsed)}`,
          Math.min(1, elapsed / (maxJobMinutes * 60)),
        );
      case 'draining':
        return line(s.drainEndsAt === null ? 'Finishing' : `Finishing, stops in ${Math.max(1, Math.ceil((s.drainEndsAt - nowSecs) / 60))} min`);
      case 'cleaning': return line('Deleting the VM');
      default: return line(STATE_LABELS[s.state as RunnerState] ?? 'Working');
    }
  });
}

/** The supervisor's own stop reasons, beside the `Reason` names. */
const AUDIT_REASONS: Record<string, string> = {
  slept: 'this Mac slept',
  removed: 'the runner was removed',
  bootTimeout: 'the VM never started',
  idle: 'idle too long',
  signal: 'the daemon stopped it',
};
/** Known names read as phrases; anything else is the supervisor's own error text, shown as written. */
const auditWhy = (reasons: string[]) => reasons.map((r) => {
  if (own(REASONS, r)) return REASONS[r].short;
  if (Object.prototype.hasOwnProperty.call(AUDIT_REASONS, r)) return AUDIT_REASONS[r];
  return r.length > 80 ? `${r.slice(0, 79)}…` : r;
}).join(', ');

/** One recent-jobs row. `rerun` is the runner's current `rerunLostJobs`; the line does not say whether that job was re-run. */
export function auditText(l: AuditLine, rerun = true): string {
  if (l.result === 'failedToStart') return 'A VM failed to start';
  // The reason names the registration and where it lives, for deleting it by hand.
  if (l.result === 'notRemoved') return l.reason.join(', ') || 'A runner registration could not be removed; delete it by hand';
  const name = [l.workflow, l.job].filter(Boolean).join(' · ') || l.repo || 'A job';
  const why = l.reason.length ? ` (${auditWhy(l.reason)})` : '';
  const took = formatMinutes(l.seconds);
  switch (l.result) {
    case 'finished': return `${name} · finished · ${took} · VM deleted`;
    case 'lost': return `${name} · lost${why}${rerun ? ' · re-run if allowed' : ''}`;
    default:
      if (l.reason.includes('maxJobTime')) return `${name} · stopped at the max job time · VM deleted`;
      return `${name} · stopped after ${took}${why} · VM deleted`;
  }
}

/** The network fact: trust plus which network, so "Not trusted" always says which one. */
export function networkText(h: HostView): string {
  if (h.networkId === null) return 'Unknown';
  // The daemon's id is `gw:<router MAC>`; its last three octets tell routers apart at a glance.
  const mac = h.networkId.startsWith('gw:') ? h.networkId.slice(3).split(':') : [];
  const name = mac.length === 6 ? `router ${mac.slice(3).join(':')}` : h.networkId;
  return `${h.networkTrusted ? 'Trusted' : 'Not trusted'} · ${name}`;
}

/** Empty until the daemon has sampled the Mac (0 means unknown, never "0 GB"). */
export function recommendationText(h: HostView): string {
  const gb = Math.round(h.recommendedMemoryMb / 1024);
  return gb > 0 ? `Recommended: ${gb} GB for this Mac` : '';
}

/** The keys of `draft` that differ from `base` (arrays by value): `runner:update` merges a patch, so unchanged keys a push moved meanwhile stay as the daemon has them. */
export function settingsPatch(base: RunnerSettings, draft: RunnerSettings): Partial<RunnerSettings> {
  return Object.fromEntries(
    (Object.keys(draft) as (keyof RunnerSettings)[])
      .filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(base[k]))
      .map((k) => [k, draft[k]]),
  ) as Partial<RunnerSettings>;
}

export function runnerActivity(views: RunnerView[]): { vms: number; awake: boolean } {
  return { vms: views.reduce((n, v) => n + v.slots.length, 0), awake: views.some((v) => v.awake) };
}

export interface ConnectForm {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  kind: 'repo' | 'org';
  target: string;
  /** Comma or space separated; `name` or `org/name`. Org scope only. */
  repos: string;
  allowPublic: boolean;
  label: string;
  priority: Priority;
}

const NAME = /^[A-Za-z0-9._-]+$/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const id = (s: string) => (/^\d+$/.test(s.trim()) && Number.isSafeInteger(Number(s.trim())) ? Number(s.trim()) : null);

/** The connect sheet's fields as the daemon's `ConnectRequest`, or the first sentence to fix. */
export function toConnectRequest(f: ConnectForm, keyStored: boolean): GithubConnectRequest | { error: string } {
  const appId = id(f.appId);
  if (appId === null) return { error: 'The App ID is a number.' };
  if (appId === 0) return { error: 'The App ID is a number above 0.' };
  const installationId = id(f.installationId);
  if (installationId === null) return { error: 'The installation ID is a number.' };
  if (installationId === 0) return { error: 'The installation ID is a number above 0.' };
  const key = f.privateKeyPem.trim();
  if (!key && !keyStored) return { error: "Paste the app's private key." };
  if (key.startsWith('-----BEGIN PRIVATE KEY-----')) return { error: 'Paste the key as GitHub downloads it (BEGIN RSA PRIVATE KEY).' };
  const target = f.target.trim();
  let scope: Scope;
  let repos: string[] = [];
  if (f.kind === 'repo') {
    const [owner, repo, extra] = target.split('/');
    if (extra !== undefined || !owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return { error: 'Enter the repo as owner/name.' };
    scope = { kind: 'repo', owner, repo };
  } else {
    if (!NAME.test(target)) return { error: 'Enter the org name.' };
    scope = { kind: 'org', org: target };
    repos = f.repos.split(/[\s,]+/).filter(Boolean).map((r) => (r.includes('/') ? r : `${target}/${r}`));
    if (!repos.length) return { error: 'Pick at least one repo in the org.' };
  }
  const label = f.label.trim() || DEFAULT_RUNNER_LABEL;
  if (!LABEL.test(label)) return { error: 'Labels use letters, digits, dot, dash and underscore.' };
  return {
    provider: 'github',
    scope,
    appId,
    installationId,
    ...(key ? { privateKeyPem: key } : {}),
    repos,
    allowPublic: f.allowPublic,
    label,
  };
}
