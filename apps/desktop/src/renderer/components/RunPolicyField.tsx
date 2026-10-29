import React from 'react';
import type { AutomationRunPolicy } from '@nekko-agent/shared';
import { RUN_POLICY_OPTIONS, effectiveRunPolicy, runPolicyLabel } from '@nekko-agent/shared';
import { useStore } from '../store.js';

/**
 * When an automation that nobody started just now may run (`runPolicy`).
 * Unset follows Settings → Automations, which itself defaults by where the
 * model runs: a local model waits until you are away, a cloud one runs on time.
 */
export function RunPolicyField({
  value, local, note, compact = false, onChange,
}: {
  value: AutomationRunPolicy | undefined;
  /** The automation's model runs on this computer. */
  local: boolean;
  /** What never waits, for this kind of automation. */
  note: string;
  /** A dialog's field rather than an editor section's: its label and size. */
  compact?: boolean;
  onChange: (value: AutomationRunPolicy | undefined) => void;
}) {
  const settings = useStore((s) => s.settings);
  const fallback = effectiveRunPolicy(undefined, settings, local);
  const shown = value ?? fallback;
  return (
    <label className="block">
      <span className={compact ? 'block text-[11px] font-medium text-ink-faint' : 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint'}>
        When it runs
      </span>
      <select
        className={compact ? 'input mt-1 w-full text-[12.5px]' : 'input w-full'}
        data-run-policy
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || undefined) as AutomationRunPolicy | undefined)}
      >
        <option value="">Default: {runPolicyLabel(fallback)}</option>
        {RUN_POLICY_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <span className="mt-1 block text-[11px] text-ink-faint" data-run-policy-hint>
        {RUN_POLICY_OPTIONS.find((o) => o.id === shown)?.hint}
        {!value && !settings?.automationRunPolicy && (local ? ' Its model runs on this computer.' : ' Its model does not run on this computer.')}
        {' '}{note}
      </span>
    </label>
  );
}
