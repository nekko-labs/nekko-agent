import React, { useLayoutEffect, useRef, useState } from 'react';

export interface SlideOption<T extends string> {
  id: T;
  /** Accessible name and tooltip. */
  label: string;
  /** What the segment shows; the label when absent. */
  content?: React.ReactNode;
}

/**
 * A segmented choice whose highlight slides to the picked segment. A
 * radiogroup: one tab stop, arrow keys, Home and End move the choice.
 */
export function SlideToggle<T extends string>({ options, value, onChange, label, iconOnly = false, className = '', transitionName }: {
  options: ReadonlyArray<SlideOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  iconOnly?: boolean;
  className?: string;
  /**
   * Names the thumb and segments for a page view transition, so the thumb still
   * slides (and the labels stay above it) while the rest of the page morphs.
   */
  transitionName?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  // The first placement jumps; later ones slide.
  const placed = useRef(false);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[aria-checked="true"]');
      setThumb(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
    };
    place();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [value, options]);
  useLayoutEffect(() => { if (thumb) requestAnimationFrame(() => { placed.current = true; }); }, [thumb]);

  const move = (e: React.KeyboardEvent, i: number) => {
    const last = options.length - 1;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i === 0 ? last : i - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next].id);
    root.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div ref={root} role="radiogroup" aria-label={label} className={`slide-toggle ${iconOnly ? 'slide-toggle-icons' : ''} ${className}`}>
      {thumb && <span aria-hidden className="slide-toggle-thumb" data-animate={placed.current || undefined} style={{ width: thumb.w, transform: `translateX(${thumb.x}px)`, viewTransitionName: transitionName ? `${transitionName}-thumb` : undefined }} />}
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          aria-label={iconOnly ? o.label : undefined}
          title={o.label}
          tabIndex={o.id === value ? 0 : -1}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => move(e, i)}
          style={transitionName ? { viewTransitionName: `${transitionName}-${i}` } : undefined}
        >
          {o.content ?? o.label}
        </button>
      ))}
    </div>
  );
}
