/**
 * Booted iOS simulators and Android emulators, what each costs in CPU, and
 * which chat last used it (`simulators:*`, issue #2814). The daemon samples
 * them (crates/nekkod/src/simulators.rs); these are the shapes and the
 * wording every surface shares.
 */

export interface SimulatorUse {
  sessionId: string;
  /** Epoch ms of the agent's last command on it. */
  at: number;
  /** The chat's title, when it has one. */
  title?: string | null;
}

export interface BootedSimulator {
  /** The UDID on iOS, the AVD name on Android. */
  id: string;
  kind: 'ios' | 'android';
  name: string;
  /** "iPhone 18 Pro". */
  model?: string;
  /** "iOS 27.0". */
  os?: string;
  /** Percent of one core, summed over the device's processes (can pass 100). */
  cpuPct: number;
  upSecs: number;
  processes: number;
  serial?: string;
  lastUse?: SimulatorUse;
  /** Simulator.app can show it (iOS; a headless emulator has no window). */
  canOpen: boolean;
}

export interface SimulatorsState {
  devices: BootedSimulator[];
  sampledAt: number;
  /** Set when idle simulators an agent used are shut down after this many minutes. */
  autoShutdownMinutes?: number | null;
}

/** `simulators:updated`: read the state again; `used` names a chat that just started on a device. */
export interface SimulatorsUpdated {
  used?: { deviceId: string; sessionId: string; at: number };
}

export interface SimulatorShot {
  mime: string;
  /** Base64. */
  data: string;
  at: number;
}

/** Auto shutdown's choices, in minutes (0 is Never) (#2814, 5 and 15 added in #2826). */
export const SIMULATOR_AUTO_SHUTDOWN_CHOICES: ReadonlyArray<readonly [number, string]> = [
  [0, 'Never'],
  [5, 'After 5 min'],
  [15, 'After 15 min'],
  [30, 'After 30 min'],
  [60, 'After 1 hour'],
  [240, 'After 4 hours'],
];

/** Below this a device counts as quiet (percent of a core). */
export const SIMULATOR_QUIET_CPU = 3;
/** Quiet and untouched this long reads as idle. */
export const SIMULATOR_IDLE_AFTER_MS = 30 * 60 * 1000;

/** "45s", "12 min", "3 h", "9 days". */
export function simulatorDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

/** How long since an agent last touched it, else since it booted. */
export function simulatorQuietForMs(d: BootedSimulator, now: number): number {
  const booted = now - d.upSecs * 1000;
  return now - Math.max(d.lastUse?.at ?? 0, booted);
}

/** "idle 9 days" for a quiet device nothing has touched in a while, else null. */
export function simulatorIdleLabel(d: BootedSimulator, now: number): string | null {
  if (d.cpuPct >= SIMULATOR_QUIET_CPU) return null;
  const quiet = simulatorQuietForMs(d, now);
  return quiet >= SIMULATOR_IDLE_AFTER_MS ? `idle ${simulatorDuration(quiet)}` : null;
}

/** "used by Fix iPad tests, 2 min ago", "used by an agent, 3 h ago", or null. */
export function simulatorUsedLabel(d: BootedSimulator, now: number): string | null {
  if (!d.lastUse) return null;
  const who = d.lastUse.title?.trim() || 'an agent';
  const ago = now - d.lastUse.at;
  return ago < 60_000 ? `used by ${who} now` : `used by ${who}, ${simulatorDuration(ago)} ago`;
}

/** "iPhone 18 Pro · iOS 27.0", the model and OS when known. */
export function simulatorDetail(d: BootedSimulator): string {
  return [d.model, d.os].filter(Boolean).join(' · ');
}

/** The booted devices this chat's agent last used, most recently used first. */
export function simulatorsForSession(state: SimulatorsState | null | undefined, sessionId: string | null | undefined): BootedSimulator[] {
  if (!state || !sessionId) return [];
  return state.devices
    .filter((d) => d.lastUse?.sessionId === sessionId)
    .sort((a, b) => (b.lastUse?.at ?? 0) - (a.lastUse?.at ?? 0));
}

/** Total CPU of every booted device, percent of one core. */
export function simulatorsCpu(state: SimulatorsState | null | undefined): number {
  return (state?.devices ?? []).reduce((sum, d) => sum + d.cpuPct, 0);
}
