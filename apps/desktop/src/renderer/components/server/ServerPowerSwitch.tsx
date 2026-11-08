import { Toggle } from '../primitives/index.js';

/**
 * A server's on/off switch and its state, as one control.
 *
 * This was a pill button that read "Serving" or "Stopped", and before that a
 * bare power glyph beside a badge. Both read as status rather than as
 * something you could flip, so it is the same switch as the "Start Server on
 * Nekko Launch" one beside it now, with the state as its label.
 *
 * Shared by the model server and the agent server so the two power controls on
 * the Model Server page look and behave identically. `unavailable` names why
 * it cannot be switched at all ("Not installed"), and disables it.
 */
export function ServerPowerSwitch({
  running,
  busy,
  disabled = false,
  unavailable,
  onToggle,
  labelWhat,
}: {
  running: boolean;
  busy: boolean;
  disabled?: boolean;
  /** Why it cannot be switched, shown instead of the state; implies disabled. */
  unavailable?: string;
  onToggle: () => void;
  /** What it powers, for the accessible label: "model server", "agent server". */
  labelWhat: string;
}) {
  const action = running ? `Stop ${labelWhat}` : `Start ${labelWhat}`;
  const label = unavailable ?? (busy ? 'Working…' : running ? 'Serving' : 'Stopped');
  return (
    <label className="flex shrink-0 items-center gap-2 text-xs font-medium" title={unavailable ?? action}>
      {/* Wide enough for every state, so the switch does not move when it flips. */}
      <span className="min-w-[4.5rem] text-right" style={{ color: running && !unavailable ? 'var(--ink)' : 'var(--ink-soft)' }}>
        {label}
      </span>
      <Toggle
        value={running && !unavailable}
        onChange={onToggle}
        disabled={disabled || busy || Boolean(unavailable)}
        label={unavailable ? `${labelWhat}: ${unavailable}` : action}
      />
    </label>
  );
}
