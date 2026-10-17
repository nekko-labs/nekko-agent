import React, { useState } from 'react';
import { ChevronIcon } from '../icons.js';
import { dayRange, monthGrid, startOfDay, type DateRange } from '../views/chatFinder.js';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * One month view that picks a from–to range: the first click sets the start,
 * the second the end (either order), hovering in between previews the span.
 * A third click starts a new range. Days after today stay selectable but read
 * faint, since nothing can have happened on them yet.
 */
export function RangeCalendar({ value, onChange, now = Date.now() }: {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  now?: number;
}) {
  const anchorDay = value?.to ?? now;
  const [month, setMonth] = useState(() => ({ y: new Date(anchorDay).getFullYear(), m: new Date(anchorDay).getMonth() }));
  const [start, setStart] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const today = startOfDay(now);
  const days = monthGrid(month.y, month.m);

  const shown: DateRange | null = start !== null ? dayRange(start, hover ?? start) : value;
  const step = (d: number) => setMonth(({ y, m }) => { const t = new Date(y, m + d, 1); return { y: t.getFullYear(), m: t.getMonth() }; });
  const pick = (day: number) => {
    if (start === null) { setStart(day); setHover(day); return; }
    onChange(dayRange(start, day));
    setStart(null);
    setHover(null);
  };
  const preset = (daysBack: number) => { setStart(null); onChange(dayRange(today - daysBack * 86_400_000, today)); setMonth({ y: new Date(today).getFullYear(), m: new Date(today).getMonth() }); };

  return (
    <div className="chat-finder-calendar select-none p-2" data-finder-calendar onMouseLeave={() => setHover(start)}>
      <div className="mb-1.5 flex items-center justify-between">
        <button type="button" className="grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-surface-2 hover:text-ink" aria-label="Previous month" onClick={() => step(-1)}>
          <ChevronIcon className="h-3.5 w-3.5 rotate-180" />
        </button>
        <span className="text-[12px] font-semibold text-ink" aria-live="polite">
          {new Date(month.y, month.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <button type="button" className="grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-surface-2 hover:text-ink" aria-label="Next month" onClick={() => step(1)}>
          <ChevronIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center" role="grid" aria-label="Pick a from and to date">
        {WEEKDAYS.map((d, i) => <span key={i} className="pb-0.5 text-[10px] font-semibold uppercase text-ink-faint" role="columnheader">{d}</span>)}
        {days.map((day) => {
          const outside = new Date(day).getMonth() !== month.m;
          const sel = !!shown && day >= startOfDay(shown.from) && day <= shown.to;
          const edge = !!shown && (day === startOfDay(shown.from) || day === startOfDay(shown.to));
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              aria-selected={sel}
              aria-label={new Date(day).toDateString()}
              data-day={new Date(day).getDate()}
              data-in-range={sel || undefined}
              data-edge={edge || undefined}
              data-today={day === today || undefined}
              className={`chat-finder-day h-7 text-[11.5px] tabular-nums ${outside ? 'opacity-40' : ''} ${day > today ? 'is-future' : ''}`}
              onMouseEnter={() => { if (start !== null) setHover(day); }}
              onClick={() => pick(day)}
            >
              {new Date(day).getDate()}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
        {([['Today', 0], ['7 days', 6], ['30 days', 29], ['90 days', 89]] as const).map(([label, back]) => (
          <button key={label} type="button" className="chat-finder-chip" onClick={() => preset(back)}>{label}</button>
        ))}
        <span className="ml-auto text-ink-faint">{start !== null ? 'Pick the end date' : ''}</span>
        {value && <button type="button" className="chat-finder-chip" data-finder-range-clear onClick={() => { setStart(null); onChange(null); }}>Clear</button>}
      </div>
    </div>
  );
}
