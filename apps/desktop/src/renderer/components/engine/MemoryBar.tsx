import type { Aspect } from './memoryBreakdown.js';

/**
 * A stacked memory bar: one pool (graphics memory or system memory) with its
 * parts laid end to end, each part's width easing to its new size.
 *
 * Shared by the load drawer's meter and Loaded models' live bar so both read
 * the same way: other apps in a faint neutral, then the model's parts, then
 * what is free as the bare track. A part with `slices` is drawn as that many
 * equal pieces (parallel sessions sharing one context pool); a `hatched` part
 * is a load still streaming in.
 */

export interface BarSegment {
  key: string;
  bytes: number;
  color: string;
  title: string;
  slices?: number;
  hatched?: boolean;
  /** Faded while something else is highlighted. */
  dim?: boolean;
  onHover?: (on: boolean) => void;
}

/** Other apps, everywhere a bar shows them. */
export const OTHER_COLOR = 'color-mix(in srgb, var(--ink-faint) 55%, transparent)';

/** Each part of one model, as a distinct hue (the drawer: one model, many parts). */
export const ASPECT_COLOR: Record<Aspect, string> = {
  weights: 'var(--accent)',
  experts: 'color-mix(in srgb, var(--accent) 70%, var(--info))',
  context: 'var(--accent-2)',
  working: 'var(--info)',
  pinned: 'color-mix(in srgb, var(--accent) 35%, transparent)',
  model: 'var(--accent)',
};

/** Chart series one, two and three, then their blends. One per loaded model. */
const SERIES = [
  'var(--accent)',
  'var(--info)',
  'var(--accent-2)',
  'color-mix(in srgb, var(--accent) 50%, var(--info))',
  'color-mix(in srgb, var(--info) 50%, var(--accent-2))',
  'color-mix(in srgb, var(--accent-2) 50%, var(--ink-soft))',
];
export const seriesColor = (i: number) => SERIES[i % SERIES.length];

/**
 * One model's part as a shade of its series colour (the live bar: many models,
 * each split into parts). Weights are the full colour; what the settings add
 * on top gets lighter.
 */
const SHADE: Record<Aspect, number> = { weights: 100, model: 100, experts: 82, context: 62, working: 42, pinned: 28 };
export const shadeOf = (series: number, aspect: Aspect) =>
  SHADE[aspect] === 100 ? seriesColor(series) : `color-mix(in srgb, ${seriesColor(series)} ${SHADE[aspect]}%, transparent)`;

const EASE = 'transition-[width,opacity] duration-(--dur-slow) ease-(--ease-out)';

export function MemoryBar({
  segments,
  scaleBytes,
  label,
  over = false,
  marker,
  height = 'h-4',
}: {
  segments: BarSegment[];
  /** Bytes the full width stands for. */
  scaleBytes: number;
  label: string;
  /** The parts run past the pool: outline it in the danger colour. */
  over?: boolean;
  /** A thin line at a byte position, e.g. where overload protection starts. */
  marker?: { atBytes: number; title: string };
  height?: string;
}) {
  const pct = (b: number) => `${Math.max(0, (b / Math.max(1, scaleBytes)) * 100)}%`;
  const used = segments.reduce((n, s) => n + s.bytes, 0);
  return (
    <div
      className={`relative flex ${height} overflow-hidden rounded`}
      style={{ background: 'color-mix(in srgb, var(--ink-faint) 14%, transparent)', outline: over ? '2px solid var(--danger)' : undefined }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={scaleBytes}
      aria-valuenow={used}
      data-memory-bar
    >
      {segments.map((s) =>
        s.bytes <= 0 ? null : (
          <div
            key={s.key}
            className={`flex h-full shrink-0 ${EASE}`}
            style={{ width: pct(s.bytes), gap: s.slices && s.slices > 1 ? 1 : 0, opacity: s.dim ? 0.3 : 1 }}
            title={s.title}
            data-segment={s.key}
            onMouseEnter={s.onHover && (() => s.onHover?.(true))}
            onMouseLeave={s.onHover && (() => s.onHover?.(false))}
          >
            {Array.from({ length: Math.max(1, s.slices ?? 1) }, (_, i) => (
              <span
                key={i}
                className="block h-full min-w-0 flex-1"
                style={{
                  background: s.hatched
                    ? `repeating-linear-gradient(135deg, ${s.color} 0 4px, color-mix(in srgb, ${s.color} 35%, transparent) 4px 8px)`
                    : s.color,
                }}
              />
            ))}
          </div>
        ),
      )}
      {marker && marker.atBytes < scaleBytes && (
        <span
          className="absolute inset-y-0 w-px"
          style={{ left: pct(marker.atBytes), background: 'var(--danger)' }}
          title={marker.title}
          aria-hidden
        />
      )}
    </div>
  );
}

export function Swatch({ color, hatched = false }: { color: string; hatched?: boolean }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-sm"
      style={{
        background: hatched ? `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 4px)` : color,
      }}
      aria-hidden
    />
  );
}
