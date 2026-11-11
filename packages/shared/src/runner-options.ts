/**
 * CI runner options: which kinds of job VM a computer can host, and why not
 * when it cannot. The CI runners page lists all three kinds on every computer,
 * so the choice is visible everywhere, and greys out what this one cannot run.
 *
 * Today only an Apple silicon Mac runs a runner engine (macOS VMs, plus Linux
 * slots). Windows and Linux jobs on a Windows PC wait on the Hyper-V backend
 * (issue #2553), so a PC shows them as not yet available rather than as
 * needing a Mac. When that lands, the daemon reports its guests and `guests`
 * below carries them.
 */

export type RunnerKind = 'macos' | 'linux' | 'windows';

export const RUNNER_KINDS: readonly RunnerKind[] = ['macos', 'linux', 'windows'];

export interface RunnerOption {
  kind: RunnerKind;
  title: string;
  /** What it runs when available; the reason when not. */
  detail: string;
  available: boolean;
}

/** The computer the page talks to, from `machine:profile` (Node's `platform` and `arch` names). */
export interface RunnerHost {
  platform: string;
  arch: string;
}

const TITLES: Record<RunnerKind, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };

/** What each kind runs, said once, when this computer can run it. */
const WHAT: Record<RunnerKind, string> = {
  macos: 'Xcode, iOS and Mac jobs in a throwaway macOS VM',
  linux: 'Ubuntu with Docker in a throwaway VM',
  windows: 'Windows Server jobs in a throwaway VM',
};

const NEEDS_APPLE_SILICON = 'Needs a Mac with Apple silicon';
const NOT_ON_PC_YET = 'Coming to Windows PCs';

/** Apple's Virtualization framework runs macOS guests only on Apple silicon. */
const appleSilicon = (h: RunnerHost) => h.platform === 'darwin' && h.arch === 'arm64';

/**
 * Why this computer cannot run `kind`, or null when it can.
 * `engine` is whether its daemon answers the runner channels at all.
 * `guests`, once a daemon reports them, overrides what is inferred from the platform.
 */
export function runnerUnavailable(kind: RunnerKind, host: RunnerHost | null, engine: boolean, guests?: readonly RunnerKind[]): string | null {
  if (guests) return guests.includes(kind) ? null : fallbackReason(kind, host);
  if (!host) return kind === 'macos' ? NEEDS_APPLE_SILICON : NOT_ON_PC_YET;
  if (appleSilicon(host)) {
    if (kind === 'windows') return 'Needs a Windows PC';
    return engine ? null : 'Update Nekko Agent on this Mac to run it';
  }
  return fallbackReason(kind, host);
}

function fallbackReason(kind: RunnerKind, host: RunnerHost | null): string {
  if (kind === 'macos') return NEEDS_APPLE_SILICON;
  if (host?.platform === 'darwin') return kind === 'windows' ? 'Needs a Windows PC' : NEEDS_APPLE_SILICON;
  if (host?.platform === 'linux') return kind === 'windows' ? 'Needs a Windows PC' : 'Coming to Linux PCs';
  return NOT_ON_PC_YET;
}

/** Every kind, in the page's order, with this computer's answer for each. */
export function runnerOptions(host: RunnerHost | null, engine: boolean, guests?: readonly RunnerKind[]): RunnerOption[] {
  return RUNNER_KINDS.map((kind) => {
    const why = runnerUnavailable(kind, host, engine, guests);
    return { kind, title: TITLES[kind], detail: why ?? WHAT[kind], available: why === null };
  });
}
