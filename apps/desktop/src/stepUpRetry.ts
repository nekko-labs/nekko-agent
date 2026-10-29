import { stepUpRefusalOf } from '@nekko-agent/shared';

/** Opens the step-up sheet for an action class; true once the computer accepted a confirmation. */
export type StepUpHandler = (action: string | null, message: string) => Promise<boolean>;

/**
 * Run a call; when the computer refuses it `step-up-required` for an action
 * class a confirmation can cover, ask `handler()` (the page's step-up sheet)
 * and, once it confirms, run the call again, once (SK-4, SK-5).
 *
 * Shared by the desktop preload and the Local Web UI's transport, so every
 * guarded call (`window.nekko.enableRemote`, `saveProvider`, …) gets the
 * sheet without each caller knowing about step-up. Turning step-up off and
 * removing a method (`stepUpOff`) carry their own proof and are left to
 * Settings → Security.
 */
export async function withStepUpRetry<T>(run: () => Promise<T>, handler: () => StepUpHandler | null): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const refusal = stepUpRefusalOf(e);
    const ask = handler();
    if (!refusal || refusal.code !== 'step-up-required' || !refusal.action || refusal.action === 'stepUpOff' || !ask) throw e;
    if (!(await ask(refusal.action, refusal.message))) throw e;
    return run();
  }
}
