import React, { useId, useLayoutEffect, useRef, useState } from 'react';

/** Fit whole chips only, reserving the disclosure's measured width when needed. */
export function fittingPlanChips(widths: number[], available: number, disclosure: number, gap = 8): number {
  const total = widths.reduce((sum, width, i) => sum + width + (i ? gap : 0), 0);
  if (total <= available) return widths.length;
  let used = 0;
  let count = 0;
  for (const width of widths) {
    if (used + width + gap + disclosure > available) break;
    used += width + gap;
    count++;
  }
  return count;
}

/** A title and whole inline chips, with overflow revealed only on request. */
export function PlanRow({ title, chips }: { title: React.ReactNode; chips: React.ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const count = chips.length;
  const visible = Math.min(fit, count);
  const hidden = count - visible;
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || !count) return;
    const lane = row.querySelector<HTMLElement>('.plan-row-inline')!;
    const items = [...lane.querySelectorAll<HTMLElement>('[data-plan-item]')];
    const measure = () => {
      const widths = items.map(item => item.getBoundingClientRect().width);
      const probe = row.querySelector<HTMLElement>('[data-plan-count-probe]')!;
      setFit(fittingPlanChips(widths, lane.clientWidth, probe.getBoundingClientRect().width));
    };
    // Commit resize-driven visibility on the next frame, outside observer delivery.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    observer.observe(lane);
    for (const item of items) observer.observe(item);
    observer.observe(row.querySelector('[data-plan-count-probe]')!);
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [chips, count]);
  return <div ref={ref} className="plan-row-content">
    <div className="plan-row-line" data-has-chips={count > 0 || undefined}>
      <div className="plan-row-title">{title}</div>
      {count > 0 && <div className="plan-row-inline">
        {chips.map((chip, i) => <span key={i} data-plan-item data-overflowed={i >= visible || undefined} aria-hidden={i >= visible || undefined} inert={i >= visible} className="plan-row-item">{chip}</span>)}
        <span className="plan-sheet-chip plan-row-count-probe" data-plan-count-probe aria-hidden inert>+{count}</span>
        {hidden > 0 && <button type="button" className="plan-sheet-chip plan-row-count" data-plan-overflow aria-label={expanded ? 'Hide extra chips' : 'Show ' + hidden + ' more chips'} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? '−' : '+'}{hidden}</button>}
      </div>}
    </div>
    <div id={id} className="plan-row-more" data-plan-more hidden={!expanded || !hidden}>
      <div className="plan-sheet-chips">{expanded && chips.slice(visible)}</div>
    </div>
  </div>;
}
