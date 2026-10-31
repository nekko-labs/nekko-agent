import { useEffect, useState } from 'react';
import type { ToolCall, ToolResult } from '@nekko-agent/shared';
import { BinocularsIcon } from '../../icons.js';
import { usePaneVisible } from '../../paneVisibility.js';
import { parseWatchCall, parseWatchWake, prLabel, thenSummary, useAgentWatch, watchClock, watchHeadline, type WatchTone } from '../../agentWatches.js';
import { fmtDateTime, fmtTime } from './transcript.js';
import { useRowState } from './rowState.js';

/** A clock that ticks once a second while it is on screen and needed. */
function useNow(active: boolean): number {
  const visible = usePaneVisible();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !visible) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, visible]);
  return now;
}

const TONE: Record<WatchTone, string> = {
  normal: 'border-line text-ink-faint',
  quiet: 'border-transparent text-ink-faint/80',
  warn: 'border-[color:var(--warning)] text-[color:var(--warning)]',
  danger: 'border-[color:var(--danger)] text-[color:var(--danger)]',
};

export function WatchIcon() {
  return <span aria-hidden="true" className="inline-flex shrink-0 items-center text-accent"><BinocularsIcon className="h-3.5 w-3.5" /></span>;
}

/** The live status chip of an armed watch: time left, overdue, triggered. */
export function WatchClockChip({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const parsed = parseWatchCall(call, result);
  const view = useAgentWatch(parsed.action === 'create' ? parsed.id : undefined);
  const now = useNow(!!view && view.status === 'active');
  const clock = watchClock(parsed, view, now);
  if (!clock) return null;
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-2xs font-normal tabular-nums ${TONE[clock.tone]}`} title={clock.title} aria-label={clock.title} data-watch-clock={clock.tone}>
      {clock.text}
    </span>
  );
}

/** One line: what it watches and what fires it. */
export function watchCallHeadline(call: ToolCall, result?: ToolResult): string {
  if (result?.isError) return `Watch not armed · ${result.output.replace(/^Agent watch failed: /, '').slice(0, 120)}`;
  return watchHeadline(parseWatchCall(call, result));
}

/** The subline: what the agent does when the watch fires. */
export function WatchThen({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;
  return <span className={`block min-w-0 truncate font-sans text-xs text-ink-faint ${className}`} title={text}><span className="text-ink-soft">then</span> · {text}</span>;
}

export function WatchDetail({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const parsed = parseWatchCall(call, result);
  const pr = prLabel(parsed.url);
  return (
    <div className="space-y-1.5 py-1">
      {pr && parsed.url && <div className="text-ink-soft">Watching <a className="underline" href={parsed.url} target="_blank" rel="noreferrer">{pr.full}</a></div>}
      {parsed.prompt && <>
        <div className="text-ink-soft">When it fires</div>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-faint">{parsed.prompt}</pre>
      </>}
      {result && <pre className={`max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] ${result.isError ? 'text-[color:var(--danger)]' : 'text-ink-faint'}`}>{result.output}</pre>}
    </div>
  );
}

/**
 * The automated continuation a watch sent when it fired, shown as a step in
 * the run rather than as something the person typed.
 */
export function WatchWakeRow({ content, createdAt }: { content: string; createdAt: number }) {
  const wake = parseWatchWake(content);
  const [open, setOpen] = useRowState('watch-wake-open', false);
  if (!wake) return null;
  const then = thenSummary(wake.prompt);
  return (
    <div className="fade-in font-mono text-xs" data-watch-wake>
      <button className="flex w-full items-center gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Automated watch wake-up, not a message from you">
        <span className="w-3 shrink-0 text-2xs">{open ? '▾' : '▸'}</span>
        <WatchIcon />
        <span className="min-w-0 truncate font-medium text-ink-soft">Watch triggered · {wake.trigger}{wake.detail ? ` (${wake.detail})` : ''}</span>
        {createdAt > 0 && <span className="ml-auto shrink-0 text-2xs tabular-nums" title={fmtDateTime(createdAt)}>{fmtTime(createdAt)}</span>}
      </button>
      <WatchThen text={then} className="pl-[38px]" />
      {open && <pre className="ml-[18px] mt-1 max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-faint">{content}</pre>}
    </div>
  );
}
