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
  /** VMs kept booted while idle, 0 to 2. Null or missing: the mode's default (`readyVms`). */
  readyVms?: number | null;
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

export interface PrRef { number: number; url: string }
export interface JobRef {
  repo: string; runId: number; jobId: number; workflow: string; job: string;
  /** The job's page; empty when the provider gave none. Absent from older daemons. */
  url?: string;
  pr?: PrRef | null;
}
export type Guest = 'macos' | 'linux';
export interface SlotView {
  /** Absent from daemons before Linux slots: macOS. */
  guest?: Guest;
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
  /** The provider's id for the job, for `runner:jobLog`. Older daemons send none of these four. */
  jobId?: number | null;
  url?: string | null;
  pr?: PrRef | null;
  /** When the VM entered each state, oldest first; `ts` is when it was deleted. */
  events?: { ts: number; state: SlotState }[];
  /** The VM's name when nekkod kept its console log, for `runner:vmLog`. */
  vm?: string | null;
  /** What a finished job used inside its VM, when its stats disk was readable. */
  usage?: Usage;
}
/** One job's usage summary (CI runners, "Suggested VM size"). */
export interface Usage {
  cpus: number;
  memoryMb: number;
  cpuP95: number;
  cpuFullShare: number;
  memPeakMb: number;
  compressedPeakMb: number;
  swapOutMb: number;
}
/** The VM size that fits a runner's jobs at its current size; the current size when it fits or before enough jobs. */
export interface SizeSuggestion {
  jobs: number;
  cpus: number;
  memoryMb: number;
  /** The daemon's sentences: why it changed, and any limit that held it back. */
  reasons: string[];
}
export interface RunnerView {
  config: RunnerConfig;
  state: RunnerState;
  slots: SlotView[];
  reasons: Reason[];
  available: number;
  limit: SlotLimit | null;
  /** Linux VMs that may run now: no Apple cap, the memory macOS slots leave. Absent from older daemons. */
  linuxAvailable?: number;
  /** Why Linux slots cannot start (no Linux image yet), when some are asked for. */
  linuxError?: string | null;
  awake: boolean;
  error: string | null;
  today: Today;
  host: HostView;
  /** The repos an org runner serves, from its link; empty when the scope says it all. */
  repos: string[];
  /** A public repo's approval for outside contributors is unsettled, so the daemon keeps this runner off. */
  forkApprovalOpen: boolean;
  /** Newest first. */
  recent: AuditLine[];
  /** `null` until the Mac has been read. */
  suggestedSize: SizeSuggestion | null;
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
  /** False leaves a new runner off; the daemon defaults to true. */
  enabled?: boolean;
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

/** `canGroup` is null when it cannot be known: an org's plan is hidden, or a personal account. */
export interface GithubAccount { login: string; kind: 'user' | 'org'; canGroup: boolean | null }
export interface GithubAccounts { login: string | null; accounts: GithubAccount[] }
export interface GithubRepo { name: string; private: boolean }
export type GithubSetupStep = 'idle' | 'create' | 'install' | 'confirm' | 'failed';
/** The click-through connect, from `runner:githubStatus` and the `runner:githubChanged` push. */
export interface GithubSetupView {
  step: GithubSetupStep;
  owner: string | null;
  kind: 'user' | 'org' | null;
  /** The app has repo Administration, so it serves one repo, even under an org. */
  repoAdmin: boolean;
  slug: string | null;
  appId: number | null;
  installationId: number | null;
  repos: GithubRepo[];
  error: string | null;
}
export interface GithubStartRequest { owner: string; kind: 'user' | 'org'; repoAdmin?: boolean }
/** `url` is the GitHub settings page to link to when `done` is false. */
export interface ForkApproval { done: boolean; url: string }

export const IDLE_GITHUB_SETUP: GithubSetupView = {
  step: 'idle', owner: null, kind: null, repoAdmin: false, slug: null, appId: null, installationId: null, repos: [], error: null,
};
/** The runner polls every repo it serves. */
export const MAX_RUNNER_REPOS = 20;
/** More repos than this on an install means "All repositories", so none start ticked. */
const TICKED_BY_DEFAULT = 5;

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  enabled: false,
  priority: 'balanced',
  keepAwake: 'whileActive',
  macosSlots: 1,
  linuxSlots: 0,
  memoryPerVmMb: 8192,
  runnerMemoryMb: null,
  cpusPerVm: null,
  readyVms: null,
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

/** Balanced first: it is the default and the one to recommend. */
export const PRIORITIES: Priority[] = ['balanced', 'doNotDisturb', 'runnerFirst'];
/** The ready VM counts offered. Apple allows 2 macOS VMs per Mac, so never more. */
export const READY_VM_CHOICES = [0, 1, 2];
export const DEFAULT_READY_VMS = 1;

/** VMs kept booted while idle, as nekkod's `warm_slots` reads the settings (before the slot limit). */
export function readyVms(s: Pick<RunnerSettings, 'priority' | 'readyVms'>): number {
  if (s.readyVms !== null && s.readyVms !== undefined) return Math.min(s.readyVms, MAX_MACOS_SLOTS);
  return s.priority === 'doNotDisturb' ? 0 : s.priority === 'balanced' ? 1 : MAX_MACOS_SLOTS;
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  doNotDisturb: "Do not disturb: Only run when I'm idle",
  balanced: 'Balanced: in the background',
  runnerFirst: 'Runner first',
};
export const PRIORITY_DESCRIPTIONS: Record<Priority, string> = {
  doNotDisturb: "Only when you're away and plugged in. Steps aside the moment you need the Mac.",
  balanced: "Takes jobs while you work if there's headroom.",
  runnerFirst: "For a docked Mac that mostly runs CI. Jobs finish even when you're busy.",
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

/** Linux guests have no Apple cap; nekkod clamps the setting to this. */
export const MAX_LINUX_SLOTS = 8;
export const LINUX_SLOT_CHOICES = [0, 1, 2, 3, 4] as const;

/** The Linux image builder's view, from `runner:linuxImageStatus`. */
export interface LinuxImageView {
  state: 'none' | 'building' | 'ready' | 'failed';
  stage: 'download' | 'assemble' | 'provision' | 'test' | 'finish' | null;
  /** 0 to 1 within a download. */
  progress: number | null;
  message: string | null;
  /** What provisioning installed: `{ distro, runner, docker, kernel, ... }`. */
  proof: { distro?: string; runner?: string; docker?: string; kernel?: string } | null;
}

/**
 * One tile per configured macOS slot (slots past what the Mac allows are greyed with the bound's
 * sentence), then one per Linux slot. Linux VMs boot only for a queued Linux job.
 */
export function slotLines(v: RunnerView, nowSecs: number): SlotLine[] {
  const { macosSlots, linuxSlots = 0 } = v.config.settings;
  const of = (g: Guest) => v.slots.filter((s) => (s.guest ?? 'macos') === g);
  const mac = Array.from({ length: macosSlots }, (_, i) => slotLine(v, `Slot ${i + 1} · macOS`, of('macos')[i], nowSecs, i >= v.available ? slotLimitText(v.limit) : null));
  const linuxAvailable = v.linuxAvailable ?? 0;
  const linux = Array.from({ length: Math.min(linuxSlots, MAX_LINUX_SLOTS) }, (_, i) => {
    const why = v.linuxError ?? (i >= linuxAvailable ? 'the memory macOS slots leave is used up.' : null);
    return slotLine(v, `Slot ${macosSlots + i + 1} · Linux`, of('linux')[i], nowSecs, why, 'Starts a VM when a Linux job is queued');
  });
  return [...mac, ...linux];
}

function slotLine(v: RunnerView, title: string, s: SlotView | undefined, nowSecs: number, unavailable: string | null, idle = 'Starts a VM when a job is queued'): SlotLine {
  const { maxJobMinutes } = v.config.settings;
  if (!s) {
    if (unavailable !== null) return { title, text: `Not available: ${unavailable}`, progress: 0, dim: true };
    const text = v.state === 'error' ? 'Stopped until the error above is fixed'
      : v.reasons.length ? `Waiting: ${reasonText(v.reasons[0]).short}` : idle;
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
    case 'finished': return `${name} · finished · ${took}`;
    case 'lost': return `${name} · lost${why}${rerun ? ' · re-run if allowed' : ''}`;
    default:
      if (l.reason.includes('maxJobTime')) return `${name} · stopped at the max job time`;
      return `${name} · stopped after ${took}${why}`;
  }
}

const EVENT_LABELS: Record<SlotState, string> = {
  starting: 'Starting a VM',
  ready: 'VM online, waiting for a job',
  running: 'Running the job',
  draining: 'Finishing: a condition stopped being met',
  cleaning: 'Stopping the VM',
};

/** A recent job's VM, step by step, ending when the VM was deleted. Empty for lines with no VM. */
export function auditTimeline(l: AuditLine): { ts: number; text: string }[] {
  if (l.result === 'notRemoved') return [];
  const why = l.reason.length ? ` (${auditWhy(l.reason)})` : '';
  const end = {
    finished: 'The job finished and the VM powered off',
    stopped: `Stopped${why}`,
    lost: `Lost${why}`,
    failedToStart: `The VM failed to start${why}`,
  }[l.result];
  return [
    ...(l.events ?? []).map((e) => ({ ts: e.ts, text: EVENT_LABELS[e.state] ?? 'Working' })),
    { ts: l.ts, text: `${end}; VM deleted` },
  ];
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

/** Jobs at the current size before the daemon suggests a size (`SUGGEST_MIN_JOBS` in nekko-runner). */
export const SUGGEST_MIN_JOBS = 3;

const sizeLabel = (cpus: number, memoryMb: number) => `${cpus} vCPUs, ${Math.round(memoryMb / 1024)} GB`;

/**
 * The suggested-size row in runner settings: one line, the daemon's reasons, and the patch Apply
 * sends when the suggestion differs from the saved size. `null` hides the row (the Mac is unread).
 */
export function suggestedSizeRow(v: RunnerView): { line: string; reasons: string[]; apply: Pick<RunnerSettings, 'cpusPerVm' | 'memoryPerVmMb'> | null } | null {
  const s = v.suggestedSize;
  if (!s) return null;
  if (s.jobs < SUGGEST_MIN_JOBS) {
    return { line: `Suggested size after ${SUGGEST_MIN_JOBS} jobs at this size (${s.jobs} so far).`, reasons: [], apply: null };
  }
  const now = { cpus: v.host.cpusPerVm, memoryMb: v.config.settings.memoryPerVmMb };
  if (s.cpus === now.cpus && s.memoryMb === now.memoryMb) {
    return { line: `Fits your last ${s.jobs} jobs.`, reasons: s.reasons, apply: null };
  }
  return {
    line: `Suggested for your jobs: ${sizeLabel(s.cpus, s.memoryMb)} (now ${sizeLabel(now.cpus, now.memoryMb)}).`,
    reasons: s.reasons,
    apply: { cpusPerVm: s.cpus, memoryPerVmMb: s.memoryMb },
  };
}

/** The keys of `draft` that differ from `base` (arrays by value): `runner:update` merges a patch, so unchanged keys a push moved meanwhile stay as the daemon has them. */
export function settingsPatch(base: RunnerSettings, draft: RunnerSettings): Partial<RunnerSettings> {
  return Object.fromEntries(
    (Object.keys(draft) as (keyof RunnerSettings)[])
      .filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(base[k]))
      .map((k) => [k, draft[k]]),
  ) as Partial<RunnerSettings>;
}

/** The image build's stages, in order. A refresh runs only `REFRESH_STAGES`, adding tools only `TOOLS_STAGES`. */
export const IMAGE_STAGES = ['check', 'download', 'install', 'xcode', 'lockdown', 'scripts', 'tools', 'test', 'finish'] as const;
export type ImageStage = (typeof IMAGE_STAGES)[number];
/**
 * A build from Apple's image (with or without Xcode), or the image in use with Nekko's
 * scripts replaced, or with the job tools it lacks installed.
 */
export type ImageKind = 'xcode' | 'macosOnly' | 'refresh' | 'tools';
const REFRESH_STAGES: readonly ImageStage[] = ['check', 'scripts', 'test', 'finish'];
const TOOLS_STAGES: readonly ImageStage[] = ['check', 'tools', 'test', 'finish'];
const FULL_STAGES: readonly ImageStage[] = IMAGE_STAGES.filter((s) => s !== 'scripts' && s !== 'tools');
/** The stages a build of `kind` runs; a view with no build lists a full one. */
export const imageStages = (kind: ImageKind | null): readonly ImageStage[] =>
  kind === 'refresh' ? REFRESH_STAGES : kind === 'tools' ? TOOLS_STAGES : FULL_STAGES;
export type ImageState = 'none' | 'ready' | 'building' | 'waiting' | 'failed';

/** What the image holds, from the proof file `provision.sh` writes. */
export interface ImageInfo {
  macos: string;
  xcode: string | null;
  actionsRunner: string;
  built: string;
  /** The job tools found on the image's disk; absent for an image built before Nekko looked. */
  tools?: string[];
  /** Tools jobs run before their own setup (node, gh, jq) that this image lacks; absent from an older daemon. */
  missingTools?: string[];
}

/** "a", "a and b", "a, b and c". */
const andList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The runner card's notice for an image without some job tools. */
export function missingToolsLine(tools: string[]): string {
  const one = tools.length === 1;
  return `${andList(tools)} ${one ? 'is' : 'are'} missing from this Mac's runner image. Jobs that need ${one ? 'it' : 'them'} will fail.`;
}

export interface ImageView {
  state: ImageState;
  /** The build under way or stopped, null with none. */
  kind: ImageKind | null;
  /** The stage running, failed, waiting, or next to resume. */
  stage: ImageStage | null;
  doneStages: ImageStage[];
  /** What the stage is doing now, or why it waits. */
  detail: string;
  /** Received and total bytes, during Download. */
  bytes: [number, number] | null;
  /** 0 to 1, during Install. */
  fraction: number | null;
  /** The sentence to show when `state` is `failed`. */
  error: string | null;
  /** The end of the build log, for a failure. */
  log: string | null;
  info: ImageInfo | null;
  /** A stopped build can pick up where it left off. */
  canResume: boolean;
}

export interface ImageBuildRequest {
  kind: ImageKind;
  /** The runner to turn on when the build finishes. */
  runnerId?: string;
  /** The mode that runner gets. */
  priority: Priority;
}

/** The daemon's words for a runner with no image, which the card replaces with **Set up this Mac**. */
export const NO_IMAGE_ERROR = 'No VM image yet.';

/** What setting up this Mac would use, from `runner:imagePlan`. */
export interface ImagePlan {
  /** This Mac's Xcode version, or null with no Xcode to copy in. */
  xcode: string | null;
  /** Null before the daemon's first reading. */
  freeGb: number | null;
  needsGb: number;
  /** A macOS image kept from an earlier build, reused while it is still Apple's newest. */
  cachedMacos: boolean;
}

export const IMAGE_STAGE_LABELS: Record<ImageStage, string> = {
  check: 'Check this Mac',
  download: 'Download the macOS image',
  install: 'Install the macOS VM',
  xcode: 'Add Xcode and tools',
  lockdown: 'Lock the VM down',
  scripts: "Update Nekko's scripts",
  tools: 'Install the missing tools',
  test: 'Test a boot',
  finish: 'Turn the runner on',
};

export type StageMark = 'done' | 'now' | 'bad' | 'todo';
export interface StageRow { stage: ImageStage; label: string; mark: StageMark; note: string }

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** The stage's own progress. A wait keeps the last stage's numbers, so they only count while building. */
function stageNote(v: ImageView): string {
  if (v.state === 'failed') return 'Failed';
  if (v.state === 'waiting') return 'Waiting';
  if (v.state !== 'building') return 'Paused';
  if (v.bytes) return `${gb(v.bytes[0])} of ${gb(v.bytes[1])} GB`;
  if (v.fraction !== null) return `${Math.round(v.fraction * 100)}%`;
  return v.detail;
}

/**
 * One row per stage a person follows; Finish is one rename, so it has none. A wait
 * names the stage it waits for before the last one is listed as done, so order counts too.
 */
export function imageStageRows(v: ImageView): StageRow[] {
  const stages = imageStages(v.kind);
  const at = v.stage === null ? -1 : stages.indexOf(v.stage);
  return stages.filter((s) => s !== 'finish').map((stage, i) => {
    const done = i < at || v.doneStages.includes(stage);
    const mark: StageMark = stage === v.stage && !done ? (v.state === 'failed' ? 'bad' : 'now') : done ? 'done' : 'todo';
    return { stage, label: IMAGE_STAGE_LABELS[stage], mark, note: mark === 'now' || mark === 'bad' ? stageNote(v) : '' };
  });
}

/** 0 to 1 for the bar, or null when this stage has nothing to measure. */
export function imageFraction(v: ImageView): number | null {
  if (v.state !== 'building') return null;
  if (v.bytes && v.bytes[1] > 0) return Math.min(1, v.bytes[0] / v.bytes[1]);
  return v.fraction;
}

/** A build is running or stopped on a failure, so the sheet follows it. */
export const imageBusy = (v: ImageView) => v.state === 'building' || v.state === 'waiting' || v.state === 'failed';

/** What the runner card says about a build in progress. */
export function imageLine(v: ImageView): string {
  if (v.state === 'failed') return `Setup stopped: ${v.error ?? 'Something went wrong.'}`;
  const stage = v.stage ? IMAGE_STAGE_LABELS[v.stage] : 'Setting up this Mac';
  if (v.state === 'waiting') return `${stage}: ${v.detail}`;
  const note = stageNote(v);
  return note ? `${stage}: ${note}` : stage;
}

/** The message a new chat starts with. The person reads it and presses Send. */
export function runnerWorkflowPrompt(v: RunnerView): string {
  const { scope, label } = v.config;
  const repos = (v.repos.length ? v.repos : [scopeName(scope)]).map((r) => `\`${r}\``).join(', ');
  return [
    'Connect my Mac runner to my GitHub Actions workflows.',
    '',
    `Runner label: \`${label}\``,
    `Repos: ${repos}`,
    '',
    "Read the workflows, then ask me which ones should run on this Mac. Offer only jobs that can run on macOS, and warn me about any that run on pull requests from forks. If the repo isn't in this folder, ask me where it is.",
    '',
    `Set \`runs-on: [self-hosted, macOS, ARM64, ${label}]\` on the ones I pick, and open a pull request.`,
  ].join('\n');
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
  /** VMs kept ready, 0 to 2. */
  readyVms: number;
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

/** A personal account's runner, or an org's that cannot use runner groups, serves one repo. */
export const servesOneRepo = (v: GithubSetupView) => v.kind === 'user' || v.repoAdmin;

export function defaultRepoPicks(v: GithubSetupView): string[] {
  if (servesOneRepo(v)) return v.repos.length === 1 ? [v.repos[0].name] : [];
  return v.repos.length > TICKED_BY_DEFAULT ? [] : v.repos.map((r) => r.name);
}

/** The picks after ticking `name` on or off, or a sentence saying why not. */
export function tickRepo(v: GithubSetupView, picked: string[], name: string, on: boolean): { picked: string[]; error: string | null } {
  if (servesOneRepo(v)) return { picked: [name], error: null };
  if (!on) return { picked: picked.filter((r) => r !== name), error: null };
  if (picked.includes(name)) return { picked, error: null };
  if (picked.length >= MAX_RUNNER_REPOS) return { picked, error: `A runner serves at most ${MAX_RUNNER_REPOS} repos.` };
  return { picked: [...picked, name], error: null };
}

export const publicPicks = (v: GithubSetupView, picked: string[]) =>
  v.repos.filter((r) => !r.private && picked.includes(r.name)).map((r) => r.name);

export interface SetupPicks { repos: string[]; allowPublic: boolean; label: string }

/**
 * The confirm step as a `runner:connect` request, or the sentence to fix. Every
 * runner connects off, because its mode is chosen on the Mac setup sheet. A public
 * repo's runner also cannot start until GitHub holds outside contributors for approval.
 */
export function toSetupRequest(v: GithubSetupView, p: SetupPicks): GithubConnectRequest | { error: string } {
  if (!v.owner || v.appId === null || v.installationId === null) return { error: 'GitHub is not connected yet.' };
  if (!p.repos.length) return { error: 'Pick at least one repo.' };
  if (p.repos.length > MAX_RUNNER_REPOS) return { error: `A runner serves at most ${MAX_RUNNER_REPOS} repos.` };
  const anyPublic = publicPicks(v, p.repos).length > 0;
  if (anyPublic && !p.allowPublic) return { error: 'Choose how to handle the public repo first.' };
  const label = p.label.trim() || DEFAULT_RUNNER_LABEL;
  if (!LABEL.test(label)) return { error: 'Labels use letters, digits, dot, dash and underscore.' };
  const [owner, repo] = p.repos[0].split('/');
  const scope: Scope = servesOneRepo(v) ? { kind: 'repo', owner, repo } : { kind: 'org', org: v.owner };
  return {
    provider: 'github',
    scope,
    appId: v.appId,
    installationId: v.installationId,
    repos: servesOneRepo(v) ? [] : p.repos,
    allowPublic: anyPublic,
    label,
    enabled: false,
  };
}

export const githubInstallUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;
/** Where fork approval is set by hand, when Nekko could not ask. */
export const githubActionsSettingsUrl = (s: Scope) =>
  (s.kind === 'org' ? `https://github.com/organizations/${s.org}/settings/actions` : `https://github.com/${s.owner}/${s.repo}/settings/actions`);
/** Where an org's app is deleted, which is the way out when the org turns out to have no runner groups. */
export const githubAppSettingsUrl = (org: string, slug: string) => `https://github.com/organizations/${org}/settings/apps/${slug}/advanced`;
