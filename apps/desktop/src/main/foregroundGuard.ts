/**
 * Stay out of the way of a full-screen app (a game, a presentation, a video).
 *
 * A window that takes the foreground from an exclusive-fullscreen game knocks
 * it out of exclusive mode, and the game stays slower until it restarts; a
 * toast banner over it can do the same. So while nekkod says a full-screen app
 * is in front (`activity:fullscreen`, Windows only), notices wait and windows
 * do not come forward. Both happen as before once it is gone.
 *
 * Anything the user does to reach Nekko (the tray, a toast, a shortcut) means
 * they already left the game, so it passes straight through. Without an answer
 * (service stopped, still starting, another platform) nothing waits.
 */

export interface ForegroundGuardOptions {
  /** `activity:fullscreen` from nekkod. */
  ask: () => Promise<{ quiet?: unknown } | null | undefined>;
  /** True when one of Nekko's own windows has focus: never wait on ourselves. */
  ownFocus: () => boolean;
  /** Longest wait for an answer before going ahead as before. */
  answerMs?: number;
  /** How often to look again while waiting. */
  pollMs?: number;
}

/** The answer comes from the daemon over loopback; a slow one is treated as none. */
export const ANSWER_MS = 400;
/** How often a held window or notice checks whether the full-screen app is gone. */
export const POLL_MS = 2000;

export function createForegroundGuard(options: ForegroundGuardOptions) {
  const answerMs = options.answerMs ?? ANSWER_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  let waiting: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  /** Whether a full-screen app other than ours is in front now. */
  const quiet = async (): Promise<boolean> => {
    if (disposed || options.ownFocus()) return false;
    let late: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { late = setTimeout(() => resolve(null), answerMs); });
    try {
      const answer = await Promise.race([options.ask().catch(() => null), timeout]);
      return answer?.quiet === true;
    } finally { clearTimeout(late); }
  };

  const poll = () => {
    timer = setTimeout(async () => {
      timer = undefined;
      if (disposed) return;
      if (await quiet()) { poll(); return; }
      const run = waiting;
      waiting = [];
      for (const fn of run) fn();
    }, pollMs);
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    quiet,
    /** Run `fn` now, or once no full-screen app is in front. */
    async whenFree(fn: () => void): Promise<void> {
      if (!(await quiet())) { fn(); return; }
      if (disposed) return;
      waiting.push(fn);
      if (!timer) poll();
    },
    dispose() { disposed = true; clearTimeout(timer); timer = undefined; waiting = []; },
  };
}

export type ForegroundGuard = ReturnType<typeof createForegroundGuard>;

/**
 * Notices held while a full-screen app is in front, delivered when it is gone:
 * one per chat and kind (the newest), so a long game ends with a short list
 * rather than every step of every chat.
 */
export function holdNotices<N extends { sessionId: string; kind: string }>(guard: Pick<ForegroundGuard, 'whenFree'>, post: (notice: N) => void) {
  const held = new Map<string, N>();
  let flushing = false;
  return (notice: N) => {
    const key = `${notice.sessionId}:${notice.kind}`;
    if (flushing) { held.delete(key); held.set(key, notice); return; }
    flushing = true;
    held.set(key, notice);
    void guard.whenFree(() => {
      flushing = false;
      const due = [...held.values()];
      held.clear();
      for (const n of due) post(n);
    });
  };
}
