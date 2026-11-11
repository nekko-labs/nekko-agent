import React from 'react';
import { CheckIcon } from '../icons.js';

/**
 * Settings on quiet surfaces (docs/design-system.md), the way Security does it:
 * a section is a heading, one line of help and its rows, separated by space.
 * No card, no border, no tile.
 */
export function SettingsSection({
  id, title, help, meta, actions, children, className = '', ...rest
}: {
  title: React.ReactNode;
  /** One line under the heading, at most. */
  help?: React.ReactNode;
  /** A word or two beside the heading: a status, a count. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={`settings-section min-w-0 ${className}`} {...rest}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">{title}</h2>
        {meta != null && <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">{meta}</span>}
        {actions != null && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {help != null && <p className="mt-(--q-tight) text-xs text-ink-faint">{help}</p>}
      {children}
    </section>
  );
}

/** A small label over a run of rows inside a section ("Methods", "When to ask"). */
export function SettingsLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`quiet-group-label mt-(--q-group) mb-(--q-heading) ${className}`}>{children}</div>;
}

/**
 * One setting: a title, an optional line of detail, and its control on the
 * right. `htmlFor` makes the title the control's label.
 */
export function SettingRow({
  title, detail, detailId, control, htmlFor, disabled = false, className = '', ...rest
}: {
  title: React.ReactNode;
  detail?: React.ReactNode;
  detailId?: string;
  control?: React.ReactNode;
  htmlFor?: string;
  disabled?: boolean;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  const Title = htmlFor ? 'label' : 'span';
  return (
    <div className={`flex min-h-(--q-row) min-w-0 items-center justify-between gap-4 py-(--q-inline) ${className}`} {...rest}>
      <div className="min-w-0">
        <Title htmlFor={htmlFor} className={`block text-sm font-medium ${disabled ? 'text-ink-faint' : ''}`}>{title}</Title>
        {detail != null && <p id={detailId} className={`mt-(--q-tight) text-xs ${disabled ? 'text-ink-soft' : 'text-ink-faint'}`}>{detail}</p>}
      </div>
      {control != null && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: React.ReactNode;
  detail?: React.ReactNode;
  icon?: React.ReactNode;
}

/**
 * Pick one of a few: rows, the chosen one's title in plum with a check.
 * Replaces the bordered option tiles.
 */
export function ChoiceList<T extends string>({
  items, value, onChange, label, className = '',
}: {
  items: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`-mx-3 mt-(--q-inline) ${className}`}>
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={on}
            className="quiet-row items-start py-(--q-inline)"
            onClick={() => onChange(item.value)}
          >
            {item.icon != null && <span className="mt-0.5 flex shrink-0 text-ink-soft">{item.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium ${on ? 'text-accent' : ''}`}>{item.label}</span>
              {item.detail != null && <span className="mt-(--q-tight) block text-xs text-ink-faint">{item.detail}</span>}
            </span>
            <CheckIcon className={`mt-0.5 h-4 w-4 shrink-0 text-accent transition-opacity duration-(--dur-med) ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
