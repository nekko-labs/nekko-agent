/**
 * The width of an agent's companion column on the wall, as a share of its
 * window. Kept per chat in localStorage, so dragging one agent's column does
 * not move every other agent's, and a reload keeps it.
 */
export const COMPANION_DEFAULT = 0.38;
export const COMPANION_MIN = 0.2;
export const COMPANION_MAX = 0.75;
const KEY = 'nekko.companionWidth';

export function clampCompanion(share: number): number {
  if (!Number.isFinite(share)) return COMPANION_DEFAULT;
  return Math.min(COMPANION_MAX, Math.max(COMPANION_MIN, share));
}

function readAll(storage: Pick<Storage, 'getItem'> | undefined): Record<string, number> {
  try { const v = JSON.parse(storage?.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function readCompanionWidth(sessionId: string, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): number {
  const v = readAll(storage)[sessionId];
  return typeof v === 'number' ? clampCompanion(v) : COMPANION_DEFAULT;
}

export function saveCompanionWidth(sessionId: string, share: number, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    const all = readAll(storage);
    all[sessionId] = Math.round(clampCompanion(share) * 1000) / 1000;
    storage?.setItem(KEY, JSON.stringify(all));
  } catch { /* storage full or blocked; the width just won't persist */ }
}

/** The share for a pointer at `x` in a window spanning `left..left+width` (companions sit on the right). */
export function shareFromPointer(x: number, left: number, width: number): number {
  if (width <= 0) return COMPANION_DEFAULT;
  return clampCompanion((left + width - x) / width);
}
