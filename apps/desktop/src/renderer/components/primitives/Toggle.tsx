/**
 * The sliding on/off control, shared by every boolean switch in the app.
 *
 * One implementation so the track, thumb and motion stay identical wherever a
 * setting is a yes/no: server settings, load drawers, the engine's own power
 * control. `role="switch"` plus `aria-checked` is the accessibility contract.
 */
export function Toggle({
  value,
  onChange,
  disabled,
  label,
  title,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  title?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      title={title}
      disabled={disabled}
      className="relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ background: value ? 'var(--accent)' : 'color-mix(in srgb, var(--ink-faint) 30%, transparent)' }}
      onClick={() => onChange(!value)}
    >
      <span
        className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150 ease-(--ease-out)"
        style={{ transform: value ? 'translateX(16px)' : undefined }}
      />
    </button>
  );
}
