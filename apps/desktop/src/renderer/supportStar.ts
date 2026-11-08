import { create } from 'zustand';
import type { SupportStarStatus } from '@nekko-agent/shared';

interface SupportState {
  status: SupportStarStatus | null;
  busy: boolean;
  celebrating: boolean;
}
export const useSupportStar = create<SupportState>(() => ({ status: null, busy: false, celebrating: false }));
let pending: Promise<void> | null = null;
let celebrationTimer: ReturnType<typeof setTimeout> | undefined;
const seen = new Set<string>();

/** An already-starred account is thanked quietly, including on another surface or reload. */
export function firstStarCelebration(status: SupportStarStatus): boolean {
  if (status.state !== 'starred' || !status.login) return false;
  const key = `nekko.support-star.thanked.${status.login.toLowerCase()}`;
  let known = seen.has(key);
  try { known ||= localStorage.getItem(key) === '1'; localStorage.setItem(key, '1'); } catch { /* Storage can be unavailable in private web sessions. */ }
  seen.add(key);
  return status.newlyStarred === true && !known;
}

/** Shared single-flight state: a status read cannot overwrite an in-flight star. */
export function refreshSupportStar(write = false): Promise<void> {
  if (pending) return pending;
  useSupportStar.setState({ busy: true, celebrating: false });
  pending = Promise.resolve().then(async () => {
    try {
      const status = await (write ? window.nekko.supportStar() : window.nekko.supportStarStatus());
      if (!status || !['starred', 'not-starred', 'unavailable'].includes(status.state)) throw Error('Unsupported response');
      const celebrating = firstStarCelebration(status);
      useSupportStar.setState({ status, celebrating });
      clearTimeout(celebrationTimer);
      if (celebrating) celebrationTimer = setTimeout(() => useSupportStar.setState({ celebrating: false }), 1400);
    } catch {
      useSupportStar.setState({ status: { state: 'unavailable', reason: "Couldn't confirm your GitHub star. Try again or open GitHub directly." } });
    } finally {
      useSupportStar.setState({ busy: false });
      pending = null;
    }
  });
  return pending;
}
