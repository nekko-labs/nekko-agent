import React from 'react';

/**
 * A titled block of a view: heading, an optional muted meta line beside it,
 * optional right-aligned actions, then the content. Every view builds its
 * sections out of this instead of re-declaring the same header markup.
 */
export function Section({
  title, meta, actions, children, className = '',
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {meta != null && <span className="text-xs text-ink-faint">{meta}</span>}
        {actions != null && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A card whose children are rows, separated by the theme's hairline. */
export function PanelList({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  // `overflow-hidden` clips the rows to the card's radius, so a row's hover fill
  // can't square off the list's rounded top and bottom corners.
  return <div className={`card divide-y divide-(--line) overflow-hidden ${className}`}>{children}</div>;
}

/** The dashed "nothing here yet" hint used across the views. */
export function EmptyHint({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`rounded-xl border border-dashed border-line px-4 py-3 text-xs text-ink-faint ${className}`}>
      {children}
    </p>
  );
}

/** A small sentence-case label above a group of rows or fields. */
export function FieldLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-xs font-medium text-ink-soft ${className}`}>{children}</p>;
}

/** A number + caption tile (run stats, usage summaries). */
export function StatTile({
  value, label, sub, color, className = '',
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <div className={`card px-3 py-2 ${className}`}>
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="mt-0.5 text-xl font-bold tabular-nums" style={color ? { color } : undefined}>{value}</div>
      {sub != null && <div className="truncate text-2xs text-ink-faint">{sub}</div>}
    </div>
  );
}
