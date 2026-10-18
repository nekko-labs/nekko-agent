/**
 * Phase timings for the agent browser bridge. Diagnostics only: nothing here
 * reaches the model, and with no listener the recorder is a no-op.
 *
 * Startup phases, in order, for a chat's first request:
 *   driver      create the chat's driver (Playwright: connectOverCDP; native: nothing yet)
 *   window      create the hidden window and commit about:blank
 *   relay       native only: authenticated owned-page CDP relay listening
 *   spawn       native only: process spawn until its ready frame
 *   attach      CDP attachment (native: the launch command; Playwright: page adoption)
 * Then per action, for example:
 *   navigate    page.goto until load
 *   summary     title and capped body text for the reply
 */
export interface BrowserPhase { phase: string; ms: number }

export interface BrowserTiming {
  action: string;
  /** True when this request opened the chat's browser (new driver and window). */
  fresh: boolean;
  ok: boolean;
  totalMs: number;
  phases: BrowserPhase[];
  /** Size of the reply sent back to the backend, before the host formats it. */
  responseBytes: number;
}

export type PhaseMark = <T>(phase: string, run: () => Promise<T>) => Promise<T>;

/** A mark that only runs the work. */
export const untimed: PhaseMark = (_phase, run) => run();

export function phaseRecorder(now: () => number = () => performance.now()): { mark: PhaseMark; phases: BrowserPhase[] } {
  const phases: BrowserPhase[] = [];
  const mark: PhaseMark = async (phase, run) => {
    const start = now();
    try { return await run(); }
    finally { phases.push({ phase, ms: Math.round((now() - start) * 1000) / 1000 }); }
  };
  return { mark, phases };
}
