import React from 'react';

/**
 * Line-art placeholders for the Agent board's empty areas: the grid with
 * no agents on it, the automations list with nothing scheduled, the insights
 * box before any usage exists. Drawn in the same hand as the mascot (thin
 * ink strokes, round caps, no fills to speak of) and in the theme's tokens,
 * so they sit on either theme without a separate asset.
 */

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const faint = { ...stroke, opacity: 0.45 } as const;
const dashed = { ...faint, strokeDasharray: '3 4' } as const;

/** Three window frames fanned out, a cat's ears peeking over the front one, a plus waiting for the fourth. */
export function AgentsEmptyArt({ className = 'h-28 w-44' }: { className?: string }) {
  return (
    <svg viewBox="0 0 176 112" className={className} aria-hidden="true">
      <rect x="40" y="10" width="92" height="60" rx="7" {...dashed} />
      <rect x="28" y="20" width="92" height="60" rx="7" {...faint} />
      <rect x="16" y="30" width="92" height="60" rx="7" {...stroke} style={{ fill: 'var(--paper)' }} />
      <path d="M16 44h92" {...faint} />
      <circle cx="25" cy="37" r="1.6" fill="currentColor" opacity="0.5" />
      <circle cx="31" cy="37" r="1.6" fill="currentColor" opacity="0.5" />
      <path d="M26 60h40M26 68h52M26 76h30" {...faint} />
      {/* The cat, ears and sunglasses only, looking over the strip. */}
      <path d="M78 30 l5 -10 l7 7 h8 l7 -7 l5 10" {...stroke} />
      <path d="M80 30 q13 -4 26 0" {...stroke} />
      <path d="M84 27 h7 a2 2 0 0 1 2 2 v1 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 z M95 27 h7 a2 2 0 0 1 2 2 v1 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 z" fill="currentColor" opacity="0.85" />
      <path d="M93 29 h2" {...stroke} />
      <rect x="130" y="60" width="34" height="34" rx="8" {...dashed} />
      <path d="M147 69v16M139 77h16" {...stroke} style={{ color: 'var(--accent)' }} />
    </svg>
  );
}

/** A clock with a looping arrow and a small calendar page: scheduled, recurring, background. */
export function AutomationsEmptyArt({ className = 'h-24 w-40' }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 96" className={className} aria-hidden="true">
      <circle cx="52" cy="48" r="30" {...stroke} />
      <circle cx="52" cy="48" r="24" {...dashed} />
      <path d="M52 30v18l12 8" {...stroke} />
      <circle cx="52" cy="48" r="1.8" fill="currentColor" />
      <path d="M92 26 a22 22 0 1 1 -8 36" {...faint} />
      <path d="M86 56 l-3 7 l7 -2" {...faint} />
      <rect x="104" y="36" width="40" height="40" rx="6" {...stroke} />
      <path d="M104 48h40M114 30v10M134 30v10" {...stroke} />
      <path d="M113 58h8M127 58h8M113 68h8" {...faint} />
      <path d="M127 68 l3 3 l6 -6" {...stroke} style={{ color: 'var(--accent)' }} />
    </svg>
  );
}

/** Axes with a dashed trend and a few quiet bars: the chart that is waiting for its first day of usage. */
export function InsightsEmptyArt({ className = 'h-24 w-44' }: { className?: string }) {
  return (
    <svg viewBox="0 0 176 96" className={className} aria-hidden="true">
      <path d="M20 12v68h140" {...stroke} />
      <path d="M32 80v-18M52 80v-30M72 80v-24M92 80v-40M112 80v-34M132 80v-48" {...dashed} />
      <path d="M26 66 C 50 60, 60 44, 86 46 S 130 30, 156 22" {...stroke} style={{ color: 'var(--accent)' }} />
      <circle cx="156" cy="22" r="2.4" fill="var(--accent)" />
      <path d="M14 30h4M14 50h4M14 70h4" {...faint} />
    </svg>
  );
}

/** A placeholder block: the drawing, a title and a line of help, centred in a dashed card. */
export function EmptyArea({ art, title, children, action, className = '' }: { art: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line px-6 py-8 text-center text-ink-faint ${className}`}>
      <div className="text-ink-soft">{art}</div>
      <p className="text-[13.5px] font-semibold text-ink">{title}</p>
      {children && <p className="max-w-md text-[12.5px] leading-relaxed text-ink-faint">{children}</p>}
      {action && <div className="mt-1 flex gap-2">{action}</div>}
    </div>
  );
}
