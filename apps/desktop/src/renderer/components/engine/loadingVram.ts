import type { LoadingVram } from '@nekko-agent/shared';

/** What the graphics-memory bar of a load draws, as shares of the card (0-100). */
export interface VramFillView {
  /** Held by everything else when the load began. */
  othersPct: number;
  /** This load's share so far. */
  landedPct: number;
  /** What it is still expected to take, clipped at the card. */
  remainingPct: number;
  /** Where overload protection's reserve starts; null with protection off. */
  reservePct: number | null;
  landedBytes: number;
  needBytes: number;
  freeBytes: number;
  totalBytes: number;
  /**
   * Whether it fits: `reserve` reaches into what overload protection keeps
   * free (it stops there), `full` needs more than the card has.
   */
  over: 'none' | 'reserve' | 'full';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Lay a load out on its card: what others held, what it has taken, what it
 * still needs, and whether that runs into the reserve or past the end.
 * `reserveBytes` is overload protection's floor, or null when it is off.
 */
export function vramFill(v: LoadingVram, reserveBytes: number | null): VramFillView {
  const total = Math.max(1, v.totalBytes);
  const others = clamp(v.totalBytes - v.beforeBytes, 0, total);
  const landed = clamp(v.beforeBytes - v.freeBytes, 0, total - others);
  const remaining = Math.max(0, v.needBytes - landed);
  const end = others + landed + remaining;
  const over = end > total ? 'full' : reserveBytes && end > total - reserveBytes ? 'reserve' : 'none';
  const pct = (n: number) => (n / total) * 100;
  return {
    othersPct: pct(others),
    landedPct: pct(landed),
    remainingPct: pct(Math.min(remaining, total - others - landed)),
    reservePct: reserveBytes ? pct(clamp(total - reserveBytes, 0, total)) : null,
    landedBytes: landed,
    needBytes: v.needBytes,
    freeBytes: v.freeBytes,
    totalBytes: v.totalBytes,
    over,
  };
}
