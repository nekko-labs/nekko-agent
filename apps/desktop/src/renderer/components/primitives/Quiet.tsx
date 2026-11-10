import React from 'react';

/**
 * Quiet surfaces (docs/design-system.md): the blocks a screen composes so its
 * structure comes from space and type rather than borders and card tiles.
 */

/**
 * A heading and its rows. Groups stack with the group gap above them; the
 * first group in a container takes no gap. `dense` is the popover size (12px
 * row titles under a 14px heading); the page size is the default.
 */
export function Group({
  title, meta, actions, label, children, className = '', dense = false, as: Tag = 'section', ...rest
}: {
  title?: React.ReactNode;
  /** One line beside the heading: an email, a count. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Accessible name when the heading is not plain text. */
  label?: string;
  children?: React.ReactNode;
  className?: string;
  dense?: boolean;
  as?: 'section' | 'div';
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Tag aria-label={label} className={`quiet-group min-w-0 ${className}`} {...rest}>
      {(title != null || meta != null || actions != null) && (
        <div className={`flex min-w-0 items-baseline gap-2 ${dense ? 'px-3' : ''}`} style={{ marginBottom: 'var(--q-heading)' }}>
          {title != null && <h3 className="min-w-0 shrink-0 truncate text-sm font-semibold text-ink">{title}</h3>}
          {meta != null && <span className="min-w-0 truncate text-xs text-ink-faint" data-group-meta>{meta}</span>}
          {actions != null && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

/**
 * One list row: leading mark, title, detail, metadata pushed right, trailing
 * actions. No border and no resting background; hover is a neutral wash.
 */
export function Row({
  leading, title, detail, meta, trailing, selected = false, disabled = false, dense = false, stacked = false,
  onClick, role, className = '', titleClassName = '', ...rest
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  meta?: React.ReactNode;
  /** Actions outside the clickable area (a star, a menu). */
  trailing?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Popover size: 12px titles. */
  dense?: boolean;
  /** Detail under the title instead of beside it. */
  stacked?: boolean;
  onClick?: () => void;
  role?: string;
  className?: string;
  titleClassName?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title' | 'onClick' | 'role'>) {
  const body = (
    <>
      {leading != null && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className={`flex min-w-0 flex-1 ${stacked ? 'flex-col' : 'items-baseline'}`} style={stacked ? undefined : { gap: 'var(--q-inline)' }}>
        {/* The title is what people scan for: beside a detail, the detail gives way first. */}
        <span className={`${stacked ? 'min-w-0' : 'max-w-full shrink-0'} truncate ${dense ? 'text-xs' : 'text-sm'} font-medium ${disabled ? 'text-ink-faint' : selected ? 'text-accent' : ''} ${titleClassName}`} data-row-title>{title}</span>
        {detail != null && <span className={`min-w-0 truncate ${dense ? 'text-2xs' : 'text-xs'} text-ink-faint`} data-row-detail>{detail}</span>}
      </span>
      {meta != null && <span className={`shrink-0 ${dense ? 'text-2xs' : 'text-xs'} text-ink-faint tabular-nums`}>{meta}</span>}
    </>
  );
  const rowClass = `quiet-row ${dense ? '' : 'py-3'} ${className}`;
  if (!trailing) {
    return onClick
      ? <button type="button" role={role} aria-selected={role === 'option' ? selected : undefined} aria-disabled={disabled || undefined} disabled={disabled} className={rowClass} onClick={onClick} {...rest}>{body}</button>
      : <div role={role} className={rowClass} {...rest}>{body}</div>;
  }
  // Trailing actions are siblings of the clickable body, so a star click is not a pick.
  return (
    <div className={`group/row flex min-w-0 items-center rounded-lg ${className}`} data-quiet-row>
      {onClick
        ? <button type="button" role={role} aria-selected={role === 'option' ? selected : undefined} aria-disabled={disabled || undefined} disabled={disabled} className={`quiet-row flex-1 ${dense ? '' : 'py-3'}`} onClick={onClick} {...rest}>{body}</button>
        : <div role={role} className={`quiet-row flex-1 ${dense ? '' : 'py-3'}`} {...rest}>{body}</div>}
      <span className="flex shrink-0 items-center">{trailing}</span>
    </div>
  );
}

export interface QuietTab<T extends string> {
  value: T;
  label: React.ReactNode;
  /** A second, fainter word that identifies the choice ("Max", "Team"). */
  hint?: React.ReactNode;
  title?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
}

/** Words on a wash pill for the selected one; no track, no border. */
export function QuietTabs<T extends string>({
  items, value, onChange, label, className = '', role = 'tablist',
}: {
  items: QuietTab<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  /** `radiogroup` when picking commits a setting rather than switching a view. */
  role?: 'tablist' | 'radiogroup';
}) {
  const itemRole = role === 'tablist' ? 'tab' : 'radio';
  return (
    <div role={role} aria-label={label} className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role={itemRole}
            aria-selected={itemRole === 'tab' ? on : undefined}
            aria-checked={itemRole === 'radio' ? on : undefined}
            disabled={item.disabled}
            title={item.title}
            className="quiet-tab max-w-[220px]"
            onClick={() => onChange(item.value)}
          >
            {item.icon}
            <span className="min-w-0 truncate">{item.label}</span>
            {item.hint != null && <span className="shrink-0 font-normal text-ink-faint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The one hairline between sections of a different kind. */
export function Rule({ className = '', flush = false }: { className?: string; flush?: boolean }) {
  return <hr className={`quiet-rule ${flush ? 'my-0!' : ''} ${className}`} />;
}
