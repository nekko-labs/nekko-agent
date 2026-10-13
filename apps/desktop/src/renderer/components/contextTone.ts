/** Shared context-capacity colours for the composer and workspace cards. */
export function fillTone(percent: number): string {
  if (!Number.isFinite(percent)) return 'var(--ink-faint)';
  if (percent >= 85) return 'var(--danger)';
  if (percent >= 60) return 'var(--warning)';
  return 'var(--success)';
}
