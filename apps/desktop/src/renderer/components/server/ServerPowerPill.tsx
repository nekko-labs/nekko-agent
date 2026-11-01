import { STATUS } from '../../tokens.js';
import { PowerIcon } from '../runtimes/RuntimeCard.js';

/**
 * A server's power button and its state, as one control.
 *
 * These used to be two things side by side: a bare power glyph that did the
 * switching and a badge next to it that said what had happened. People read
 * the badge, clicked the badge, and nothing happened; the glyph that actually
 * worked looked like decoration. So the label *is* the button now: the pill
 * says "Serving" or "Stopped", and clicking it flips that.
 *
 * Shared by the model server and the agent server so the two power controls on
 * the Model Server page look and behave identically.
 *
 * Running is filled with the success tone (the same green the old "Serving"
 * badge used); stopped is a neutral outline, so an off server reads as quiet
 * rather than broken. `unavailable` names why it cannot be switched at all
 * ("Not installed"), and disables it.
 */
export function ServerPowerPill({
  running,
  busy,
  disabled = false,
  unavailable,
  onToggle,
  labelWhat,
  color = STATUS.success,
}: {
  running: boolean;
  busy: boolean;
  disabled?: boolean;
  /** Why it cannot be switched, shown instead of the state; implies disabled. */
  unavailable?: string;
  onToggle: () => void;
  /** What it powers, for the accessible label: "model server", "agent server". */
  labelWhat: string;
  /** Matches the identifying dot for this server. */
  color?: string;
}) {
  const action = running ? `Stop ${labelWhat}` : `Start ${labelWhat}`;
  const label = unavailable ?? (busy ? 'Working…' : running ? 'Serving' : 'Stopped');
  const on = running && !unavailable;
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-60"
      style={
        on
          ? { background: color, borderColor: color, color: '#fff' }
          : { borderColor: 'var(--line)', color: 'var(--ink-soft)' }
      }
      onClick={onToggle}
      disabled={disabled || busy || Boolean(unavailable)}
      aria-pressed={on}
      aria-label={unavailable ? `${labelWhat}: ${unavailable}` : action}
      title={unavailable ?? action}
    >
      <PowerIcon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
