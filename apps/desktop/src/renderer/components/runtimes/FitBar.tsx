import type { FitPlan } from '@nekko-agent/shared';
import { formatBytes, verdictColor } from './verdict.js';

/**
 * The whole idea in one widget.
 *
 * Weights, KV cache, and runtime overhead stacked against the device's free
 * memory, with a marker where the device ends. When a projection spills, the
 * stack visibly runs past that line, so "it will not fit" is something you see
 * before you read it.
 */

export function FitBar({ plan }: { plan: FitPlan }) {
  const budget = Math.max(1, plan.deviceFreeBytes);
  // A spill has to be visible, so the bar's scale is whichever is larger. When it
  // fits, the device edge sits at 100% and the free segment fills the remainder.
  const scale = Math.max(budget, plan.requiredBytes);
  const pct = (bytes: number) => (bytes / scale) * 100;
  const edge = (budget / scale) * 100;

  // Weights known, geometry not (the usual LM Studio case). Show the part we
  // actually know and hatch the rest, rather than throwing away a real number
  // because one term is missing.
  if (plan.verdict === 'unknown') {
    const hasWeights = plan.weightsBytes > 0;
    return (
      <div className="mt-2">
        <div
          className="flex h-6 w-full overflow-hidden rounded-md"
          style={{
            border: '1px dashed var(--line)',
            background:
              'repeating-linear-gradient(45deg, transparent, transparent 5px, color-mix(in srgb, var(--ink-faint) 12%, transparent) 5px, color-mix(in srgb, var(--ink-faint) 12%, transparent) 10px)',
          }}
          title={
            hasWeights
              ? "The weights are known; the KV cache is not, so the total cannot be projected"
              : "Not enough information to project this model's memory use"
          }
        >
          {hasWeights && (
            <div
              style={{ width: `${Math.min(100, (plan.weightsBytes / budget) * 100)}%`, background: 'var(--accent)' }}
              title={`Weights: ${formatBytes(plan.weightsBytes)}`}
            />
          )}
        </div>
        <p className="mt-1 text-2xs text-ink-faint">
          {hasWeights
            ? `Weights ${formatBytes(plan.weightsBytes)} of ${formatBytes(budget)}${plan.deviceName ? ` on ${plan.deviceName}` : ''}. KV cache unknown.`
            : 'No projection available'}
        </p>
      </div>
    );
  }

  const segments = [
    { key: 'weights', label: 'Weights', bytes: plan.weightsBytes, color: 'var(--accent)' },
    {
      key: 'kv',
      label: `KV cache`,
      bytes: plan.kvCacheBytes,
      color: 'color-mix(in srgb, var(--accent) 55%, var(--bg))',
    },
    {
      key: 'overhead',
      label: 'Runtime overhead',
      bytes: plan.overheadBytes,
      color: 'color-mix(in srgb, var(--accent) 28%, var(--bg))',
    },
  ].filter((s) => s.bytes > 0);

  const free = Math.max(0, budget - plan.requiredBytes);

  return (
    <div className="mt-2">
      <div
        className="relative flex h-6 w-full overflow-hidden rounded-md"
        style={{ background: 'color-mix(in srgb, var(--ink-faint) 10%, transparent)' }}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${pct(s.bytes)}%`, background: s.color }}
            title={`${s.label}: ${formatBytes(s.bytes)}`}
          />
        ))}
        {free > 0 && (
          <div style={{ width: `${pct(free)}%` }} title={`Free: ${formatBytes(free)}`} />
        )}

        {/* Where the device's memory runs out. Anything drawn past this line is
            what has to live in system RAM instead. */}
        {edge < 99.5 && (
          <div
            className="absolute top-0 h-full"
            style={{
              left: `${edge}%`,
              width: 2,
              background: verdictColor(plan.verdict),
              boxShadow: '0 0 0 1px var(--bg)',
            }}
            title={`${plan.deviceName ?? 'System memory'} runs out here (${formatBytes(budget)})`}
          />
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-faint">
        {segments.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label} {formatBytes(s.bytes)}
          </span>
        ))}
        <span className="ml-auto">
          {formatBytes(plan.requiredBytes)} of {formatBytes(budget)}
          {plan.deviceName ? ` on ${plan.deviceName}` : ' of system memory'}
        </span>
      </div>
    </div>
  );
}
