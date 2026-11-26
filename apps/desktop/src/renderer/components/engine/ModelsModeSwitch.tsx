import type { ModelsMode } from './ModelsHome.js';

/**
 * The parent switch of the Models section: what is on this machine, or
 * finding something new. A two-way slider rather than a third tab beside
 * Downloads and Folders, because it changes what the whole list below is
 * about, and that has to read at a glance. The thumb slides between the two
 * (200ms, the tab motion), and sits on neither while Downloads or Folders is
 * open.
 */
export function ModelsModeSwitch({
  value,
  installedCount,
  onChange,
}: {
  value: ModelsMode | null;
  installedCount: number;
  onChange: (mode: ModelsMode) => void;
}) {
  const items: Array<{ value: ModelsMode; label: string; hint?: string }> = [
    { value: 'installed', label: 'On this machine', hint: installedCount > 0 ? String(installedCount) : undefined },
    { value: 'find', label: 'Find new models' },
  ];
  const at = items.findIndex((i) => i.value === value);
  return (
    <div role="tablist" aria-label="Models on this machine or new ones" className="relative grid grid-cols-2 rounded-[10px] bg-surface-2 p-0.5" data-models-mode={value ?? 'none'}>
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-lg bg-paper shadow-sm transition-[transform,opacity] duration-(--dur-med) ease-(--ease-out) motion-reduce:transition-opacity"
        style={{ transform: `translateX(${Math.max(0, at) * 100}%)`, opacity: at < 0 ? 0 : 1 }}
      />
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          role="tab"
          aria-selected={i.value === value}
          data-models-mode-option={i.value}
          className={`relative z-[1] flex min-h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-medium transition-colors duration-(--dur-fast) focus-visible:shadow-[0_0_0_2px_var(--ring)] focus-visible:outline-none ${i.value === value ? 'text-ink' : 'text-ink-soft hover:text-ink'}`}
          onClick={() => onChange(i.value)}
        >
          {i.label}
          {i.hint && <span className="font-normal tabular-nums text-ink-faint">{i.hint}</span>}
        </button>
      ))}
    </div>
  );
}
