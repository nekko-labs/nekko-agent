import { create } from 'zustand';
import type { DesktopStepUpProof } from '@nekko-agent/shared';

/**
 * The step-up sheet's queue (SK-4, SK-5). Two kinds of ask:
 *
 * - `cover`: a guarded call was refused `step-up-required`; the sheet gets a
 *   confirmation the computer accepts (`security:confirm`), which covers the
 *   action class here for five minutes, and the transport calls again.
 * - `proof`: turning step-up off or removing a method; the sheet returns the
 *   answer itself (a key, a code or a recovery code) for that call to carry,
 *   never from the method being removed.
 */
export type StepUpAsk =
  | { id: number; mode: 'cover'; action: string | null; message: string }
  | { id: number; mode: 'proof'; title: string; not?: string | null };

interface Waiting {
  ask: StepUpAsk;
  resolve: (value: boolean | DesktopStepUpProof | null) => void;
}

interface StepUpState {
  current: StepUpAsk | null;
  queue: Waiting[];
}

export const useStepUp = create<StepUpState>(() => ({ current: null, queue: [] }));

let nextId = 1;
let active: Waiting | null = null;
/** A cover ask already open for an action class: a second call for it waits on the same answer. */
const pendingCovers = new Map<string, Promise<boolean>>();

function show(next: Waiting | undefined) {
  active = next ?? null;
  useStepUp.setState({ current: next?.ask ?? null });
}

function enqueue<T extends boolean | DesktopStepUpProof | null>(ask: StepUpAsk): Promise<T> {
  return new Promise<T>((resolve) => {
    const waiting: Waiting = { ask, resolve: resolve as Waiting['resolve'] };
    if (!active) show(waiting);
    else useStepUp.setState((s) => ({ queue: [...s.queue, waiting] }));
  });
}

/** The sheet's answer to the ask on screen; the next one in line shows. */
export function settleStepUp(id: number, value: boolean | DesktopStepUpProof | null): void {
  if (!active || active.ask.id !== id) return;
  const done = active;
  const [next, ...rest] = useStepUp.getState().queue;
  useStepUp.setState({ queue: rest });
  show(next);
  done.resolve(value);
}

/** Ask for a confirmation covering `action`: true once the computer accepted one. */
export function askStepUp(action: string | null, message: string): Promise<boolean> {
  const key = action ?? '';
  const open = pendingCovers.get(key);
  if (open) return open;
  const p = enqueue<boolean>({ id: nextId++, mode: 'cover', action, message }).finally(() => pendingCovers.delete(key));
  pendingCovers.set(key, p);
  return p;
}

/** Ask for a proof to carry (turning step-up off, removing a method), or null when cancelled. */
export function askStepUpProof(title: string, not?: string | null): Promise<DesktopStepUpProof | null> {
  return enqueue<DesktopStepUpProof | null>({ id: nextId++, mode: 'proof', title, not });
}

/** Hand the transport (preload or the Local Web UI's client) the sheet. */
export function installStepUpHandler(api: { setStepUpHandler?: (h: ((action: string | null, message: string) => Promise<boolean>) | null) => void } | undefined): () => void {
  api?.setStepUpHandler?.((action, message) => askStepUp(action, message));
  return () => api?.setStepUpHandler?.(null);
}

/** Tests: forget every ask. */
export function resetStepUp(): void {
  active = null;
  pendingCovers.clear();
  useStepUp.setState({ current: null, queue: [] });
}
