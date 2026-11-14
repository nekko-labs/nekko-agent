/**
 * The sliding on/off control, shared by every boolean switch in the app.
 *
 * One implementation so the track, thumb and motion stay identical wherever a
 * setting is a yes/no: Settings, Automations, server settings, load drawers,
 * the engine's own power control. The look is `.quiet-switch` in styles.css;
 * `role="switch"` plus `aria-checked` is the accessibility contract.
 */
export function Toggle({
  value,
  onChange,
  disabled,
  label,
  title,
  describedBy,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  title?: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      aria-describedby={describedBy}
      title={title}
      disabled={disabled}
      className="quiet-switch"
      onClick={() => onChange(!value)}
    />
  );
}
