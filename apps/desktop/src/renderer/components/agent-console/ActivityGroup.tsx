import { memo, useEffect, useMemo, useState } from 'react';
import { purposeHeadline, shortLiveStatus, summarizePurposes, summarizeThought, summarizeToolCall, toolPurpose, truncateWords, type LiveActivity, type PurposeCall } from '@nekko-agent/shared';
import { ToolActivityIcon, toolIconKind, purposeIconKind } from './ToolActivityIcon.js';
import { ToolProgressChip } from './ToolProgressChip.js';
import { isRunningTool, toolQuietSince, watchToolElapsed } from './toolProgress.js';
import { ChatIcon, ThoughtIcon } from '../../icons.js';
import { Markdown } from '../Markdown.js';
import type { Activity, ActivityRow, IndexedActivity } from './transcript.js';
import { activityRows, stepKey } from './transcript.js';
import { SubagentCue, SubagentModelChip, subagentSummary, SubagentHeadline, SubagentOpenButton } from './SubagentCue.js';
import { WatchClockChip, WatchDetail, WatchIcon, WatchThen, watchCallHeadline } from './WatchRow.js';
import { parseWatchCall, thenSummary } from '../../agentWatches.js';
import { useRowState } from './rowState.js';
import { HoverTip } from '../HoverTip.js';
import { MemoryCard } from './MemoryCard.js';
import { ReasoningBlock } from './ReasoningBlock.js';

/** Running dots ahead of a live row's text, in a fixed box so nothing shifts. */
export const LeadDots = () => <span className="dots dots-lead" aria-hidden="true" />;

/**
 * A turn's working steps, as the sequence they actually were.
 *
 * This used to be one line — "Worked on 6 steps · read_file, grep" — that hid
 * the order behind a click, and the order is the interesting part: what the
 * model thought, what it did about it, what it found, what it did next. So each
 * step is its own numbered row, in order, one line each: a thought shows where
 * it landed, a tool shows what it was pointed at, narration shows its first
 * line. Every row still opens to its full content, and the whole run still
 * collapses to the old one-liner, so a 40-step turn doesn't take over the
 * transcript.
 */
type ActivityGroupProps = { items: Activity[]; streaming?: boolean; turnRunning?: boolean; toolActivity?: LiveActivity; pendingCallId?: string };

/** Thoughts stay visible in conversation order, outside collapsible tool groups. */
export const ActivityGroup = memo(function ActivityGroup({ items, ...props }: ActivityGroupProps) {
  const parts: React.ReactNode[] = [];
  let tools: Activity[] = [];
  const flush = (index: number) => {
    if (tools.length) {
      parts.push(<ToolActivityGroup key={`tools_${index - tools.length}`} items={tools} stateKey={index - tools.length === 0 ? 'group-open' : `group-open-${index - tools.length}`} {...props} streaming={!!props.streaming && index === items.length} />);
      tools = [];
    }
  };
  items.forEach((item, index) => {
    if (item.kind === 'reasoning') {
      flush(index);
      parts.push(<ReasoningBlock key={`thought_${index}`} text={item.text} live={!!props.streaming && index === items.length - 1} duration={item.duration} />);
    } else tools.push(item);
  });
  flush(items.length);
  return <>{parts}</>;
});

const ToolActivityGroup = memo(function ToolActivityGroup({ items, streaming = false, toolActivity, pendingCallId, turnRunning = streaming, stateKey = 'group-open' }: { stateKey?: string; items: Activity[]; streaming?: boolean; turnRunning?: boolean; toolActivity?: LiveActivity; pendingCallId?: string }) {
  // Open while the turn runs (watching it work is the point), folded away
  // afterwards so a finished transcript reads as answers. Remembered per row,
  // so scrolling a transcript row out of the window and back keeps it as left.
  const [open, setOpen] = useRowState(stateKey, streaming && !items.some(it => it.kind === 'tool' && it.call.name === 'spawn_agent'));
  const tools = items.filter((it): it is Extract<Activity, { kind: 'tool' }> => it.kind === 'tool');
  const toolCount = tools.length;
  const agents = tools.filter((it) => it.call.name === 'spawn_agent');
  // A run that only arms watches reads as that watch, as a delegation run does.
  const watches = tools.filter((it) => it.call.name === 'agent_watch' && parseWatchCall(it.call).action === 'create');
  const watchOnly = !agents.length && watches.length > 0 && tools.every((it) => it.call.name === 'agent_watch');
  const lastWatch = watches[watches.length - 1];
  // A background reply that stepped aside for the person at the computer.
  const paused = streaming && shortLiveStatus(toolActivity) === 'Paused';
  // The steps as purpose groups: what each run of calls was for.
  const rows = useMemo(() => activityRows(items, pendingCallId), [items, pendingCallId]);
  const calls = tools.map(callOf);
  const failed = calls.filter((c) => c.failed).length;
  const rowRunning = (r: ActivityRow) => turnRunning && (r.kind === 'group'
    ? r.steps.some((s) => isRunningTool(s.item, pendingCallId))
    : isRunningTool(r.step.item, pendingCallId));
  const lastRow = [...rows].reverse().find(rowRunning);
  const iconRow = lastRow ?? rows[rows.length - 1];
  const tail = items[items.length - 1];
  const modelActive = streaming && !paused && !pendingCallId && !tools.some((t) => isRunningTool(t))
    && toolActivity?.steps.at(-1)?.label !== 'Retrying'
    && (tail?.kind === 'reasoning' || tail?.kind === 'tool');
  // Only the existing public reasoning event text, never provider carry/metadata.
  const publicReasoning = modelActive && tail?.kind === 'reasoning' ? tail.text : '';
  const modelLabel = publicReasoning ? 'Thinking' : 'Waiting for model';
  const summary = paused
    ? 'Paused until this computer is free'
    : streaming
    ? (lastRow ? rowHeadline(lastRow, true) : modelActive ? modelLabel : summarizePurposes(calls))
    : (toolCount ? summarizePurposes(calls) : 'Thought it through');
  const ordinary = agents.length === 0 && !watchOnly;
  // The tip lists each group with its count, then lone calls by their purpose.
  const hoverText = [summary, ...rows.flatMap((r) => (r.kind === 'group' ? [`• ${rowHeadline(r, false)} (${r.calls.length})`] : r.step.item.kind === 'tool' ? [`• ${rowHeadline(r, false)}`] : []))].join('\n');
  return (
    <div className={`${streaming ? 'fade-in ' : ''}mt-1 font-mono text-[12px]`}>
      <div className="flex min-w-0 items-center gap-1">
        <HoverTip label={ordinary ? hoverText : agents.length ? subagentSummary(agents[agents.length - 1].call) : watchCallHeadline(lastWatch.call, lastWatch.result)} multiline>
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
          {agents.length ? <SubagentCue /> : watchOnly ? <WatchIcon /> : <ToolActivityIcon kind={iconRow ? rowIconKind(iconRow) : 'other'} className="h-3 w-3 shrink-0 text-accent" />}
          {streaming && !paused && !!lastRow && <LeadDots />}
          <span className="min-w-0 truncate font-medium text-ink-soft">{agents.length ? <SubagentHeadline call={agents[agents.length - 1].call} result={agents[agents.length - 1].result} /> : watchOnly ? watchCallHeadline(lastWatch.call, lastWatch.result) : summary}</span>
          {ordinary && failed > 0 && <span className="shrink-0 text-danger" data-activity-failed>· {failed} failed</span>}
          {agents.length > 0 && <SubagentModelChip call={agents[agents.length - 1].call} />}
          {agents.length > 0 && !(agents.length === 1 && items.length === 1) && <span className="min-w-0 truncate text-accent" title={agents.map(({ call }) => subagentSummary(call)).join(', ')}>· {agents.length} subagent{agents.length === 1 ? '' : 's'}</span>}
          {watchOnly && <WatchClockChip call={lastWatch.call} result={lastWatch.result} />}
          {!open && tools.map(({ call }) => {
            const since = toolQuietSince(toolActivity, call.id);
            return since === undefined ? null : <ToolProgressChip key={call.id} since={since} />;
          })}
        </button>
        </HoverTip>
        {agents.length === 1 && <SubagentOpenButton call={agents[0].call} />}
      </div>
      {modelActive && <div className="ml-[22px] border-l border-line py-1 pl-2 text-ink-soft" data-model-activity>
        <div className="flex items-center gap-1.5"><LeadDots /><span>{publicReasoning ? 'Thinking' : toolCount ? 'Tools finished. Waiting for the model…' : 'Waiting for the model…'}</span></div>
        {publicReasoning && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed" data-public-reasoning>{publicReasoning}</pre>}
      </div>}
      {tools.filter((it) => it.call.name === 'remember').map((it) => <MemoryCard key={it.call.id} call={it.call} result={it.result} />)}
      {!open && watchOnly && <WatchThen text={thenSummary(parseWatchCall(lastWatch.call).prompt)} className="pl-[38px]" />}
      {open && (
        <ol className={`mt-0.5 ${agents.length || watchOnly ? '' : 'ml-[7px] border-l border-line pl-2.5'}`}>
          {ordinary ? rows.map((r) => r.kind === 'group' ? (
            <PurposeGroupRow
              key={`g_${stepKey(r.steps[0].item, r.steps[0].index - 1)}`}
              row={r}
              // A group stays live while any of its own calls is unfinished.
              live={rowRunning(r)}
              streaming={turnRunning}
              pendingCallId={pendingCallId}
              total={streaming ? items.length : -1}
              toolActivity={toolActivity}
            />
          ) : (
            <IndexedStepRow key={stepKey(r.step.item, r.step.index - 1)} step={r.step} streaming={turnRunning} pendingCallId={pendingCallId} total={streaming ? items.length : -1} toolActivity={toolActivity} />
          )) : items.map((it, i) => (
            <IndexedStepRow key={stepKey(it, i)} step={{ item: it, index: i + 1 }} streaming={turnRunning} pendingCallId={pendingCallId} total={streaming ? items.length : -1} toolActivity={toolActivity} />
          ))}
        </ol>
      )}
    </div>
  );
});

function callOf(it: Extract<Activity, { kind: 'tool' }>): PurposeCall {
  return { name: it.call.name, input: it.call.input, failed: it.failed };
}

/** A row's goal: a group's purpose headline, or a lone call's own. */
function rowHeadline(row: ActivityRow, running: boolean): string {
  if (row.kind === 'group') return purposeHeadline(row.purpose, row.calls, running).headline;
  const it = row.step.item;
  return it.kind === 'tool' ? purposeHeadline(toolPurpose(it.call), [callOf(it)], running).headline : '';
}

function rowIconKind(row: ActivityRow) {
  if (row.kind === 'group') return purposeIconKind(row.purpose, row.calls);
  return row.step.item.kind === 'tool' ? toolIconKind(row.step.item.call) : 'other';
}

function IndexedStepRow({ step, streaming, total, toolActivity, pendingCallId }: { step: IndexedActivity; streaming: boolean; total: number; toolActivity?: LiveActivity; pendingCallId?: string }) {
  const { item, index } = step;
  return (
    <StepRow
      index={index}
      item={item}
      quietSince={item.kind === 'tool' ? toolQuietSince(toolActivity, item.call.id) : undefined}
      // Tools stay live until their own result, not until a newer row arrives.
      live={streaming && (item.kind === 'tool' ? isRunningTool(item, pendingCallId) : index === total)}
    />
  );
}

/**
 * Adjacent calls with one purpose as one row that says the goal ("Read the
 * project's guidance · AGENTS.md, CLAUDE.md") and opens to the calls, which
 * look exactly as they do on their own. Present tense while it is the live
 * row. A group with a failed call says so and starts open, so the failure is
 * not hidden.
 */
function PurposeGroupRow({ row, live, streaming, total, toolActivity, pendingCallId }: { row: Extract<ActivityRow, { kind: 'group' }>; live: boolean; streaming: boolean; total: number; toolActivity?: LiveActivity; pendingCallId?: string }) {
  const first = row.steps[0].index;
  const failed = row.calls.filter((c) => c.failed).length;
  const [openState, setOpen] = useRowState<boolean | null>(`purpose-${first}-open`, null);
  const open = openState ?? failed > 0;
  const { headline } = purposeHeadline(row.purpose, row.calls, live);
  // The detail without the failure count, which is drawn in its own colour.
  const quiet = failed && row.purpose === 'check' && !live ? '' : purposeHeadline(row.purpose, row.calls.map((c) => ({ ...c, failed: false })), live).detail;
  const tools = row.steps.map((s) => s.item).filter((it): it is Extract<Activity, { kind: 'tool' }> => it.kind === 'tool');
  const startedAt = tools[0]?.startedAt;
  const ends = tools.map((t) => t.endedAt);
  const endedAt = ends.every((e) => e !== undefined) ? Math.max(...(ends as number[])) : undefined;
  const quiets = tools.map((t) => toolQuietSince(toolActivity, t.call.id)).filter((q): q is number => q !== undefined);
  return (
    <li className="list-none" data-purpose-group={row.purpose}>
      <button
        className="flex w-full min-w-0 items-baseline gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`${headline}\n${row.calls.length} calls`}
      >
        <span className="w-4 shrink-0 text-right text-[10px] tabular-nums opacity-60">{first}</span>
        <ToolElapsed startedAt={startedAt} endedAt={endedAt} live={live} />
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="self-center"><ToolActivityIcon kind={purposeIconKind(row.purpose, row.calls)} /></span>
        {live && <LeadDots />}
        <span className={`min-w-0 max-w-[70%] shrink-0 truncate font-medium ${live ? 'text-accent' : 'text-ink-soft'}`}>{headline}</span>
        {quiet && <span className="min-w-0 truncate" title={quiet}>· {quiet}</span>}
        {failed > 0 && <span className="shrink-0 text-danger">· {failed} failed</span>}
        <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums opacity-60">{row.calls.length}</span>
        {!open && quiets.length > 0 && <ToolProgressChip since={Math.min(...quiets)} />}
      </button>
      {open && (
        <ol className="ml-[7px] border-l border-line pl-2.5">
          {row.steps.map((s) => (
            <IndexedStepRow key={stepKey(s.item, s.index - 1)} step={s} streaming={streaming} pendingCallId={pendingCallId} total={total} toolActivity={toolActivity} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** "0.4s", "12s", "2m 5s": sub-second calls keep a decimal, since most tools are. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** How long a tool call took, ticking while it runs. Blank when no start was recorded. */
function ToolElapsed({ startedAt, endedAt, live }: { startedAt?: number; endedAt?: number; live: boolean }) {
  const running = live && startedAt !== undefined && endedAt === undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    return watchToolElapsed(setNow);
  }, [running]);
  const end = endedAt ?? (running ? now : undefined);
  const text = startedAt !== undefined && end !== undefined ? fmtElapsed(end - startedAt) : '';
  return <span className="w-11 shrink-0 text-right text-[10px] tabular-nums opacity-70" data-tool-elapsed data-running={running || undefined} title={text ? `${running ? 'Running for' : 'Took'} ${text}` : undefined}>{text}</span>;
}

/**
 * One step in the sequence: a numbered, single-line row that opens to the whole
 * thing. The headline is what a reader needs to follow the run without opening
 * anything, which for a thought means its conclusion, not its opening.
 */
function StepRow({ index, item, live, quietSince }: { index: number; item: Activity; live: boolean; quietSince?: number }) {
  const [open, setOpen] = useRowState(`step-${index}-open`, false);

  const kind =
    item.kind === 'tool' ? (item.call.name === 'spawn_agent' ? 'agent' : item.call.name === 'agent_watch' ? 'watch' : 'tool') : item.kind;
  const headline =
    item.kind === 'reasoning'
      ? summarizeThought(item.text) || 'Thought it through'
      : item.kind === 'note'
        ? truncateWords(item.text.replace(/\s+/g, ' ').trim(), 90)
        : item.call.name === 'spawn_agent' ? subagentSummary(item.call)
          : item.call.name === 'agent_watch' ? watchCallHeadline(item.call, item.result)
            : summarizeToolCall(item.call);

  const label =
    item.kind === 'reasoning'
      ? live ? 'Thinking' : item.duration != null ? `Thought ${item.duration}s` : 'Thought'
      : item.kind === 'note'
        ? 'Said'
        : kind === 'agent' || kind === 'watch' ? '' : item.call.name;

  const icon =
    kind === 'reasoning' ? <ThoughtIcon className="h-3 w-3 shrink-0 text-ink-faint" />
      : kind === 'agent' ? <SubagentCue />
        : kind === 'watch' ? <WatchIcon />
          : kind === 'note' ? <ChatIcon className="h-3 w-3 shrink-0 text-ink-faint" />
            : <ToolActivityIcon kind={item.kind === 'tool' ? toolIconKind(item.call) : 'other'} />;
  const then = kind === 'watch' && item.kind === 'tool' && parseWatchCall(item.call).action === 'create' && !item.result?.isError ? thenSummary(parseWatchCall(item.call).prompt) : '';

  return (
    <li className="list-none">
      <div className="flex min-w-0 items-center gap-1">
        <button
          className="flex min-w-0 flex-1 items-baseline gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="w-4 shrink-0 text-right text-[10px] tabular-nums opacity-60">{index}</span>
          {item.kind === 'tool' ? <ToolElapsed startedAt={item.startedAt} endedAt={item.endedAt} live={live} /> : <span className="w-11 shrink-0" />}
          <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
          <span className="self-center">{icon}</span>
          {live && <LeadDots />}
          {label && <span className={`shrink-0 font-medium ${live ? 'text-accent' : item.kind === 'tool' && item.failed ? 'text-danger' : 'text-ink-soft'}`}>{label}</span>}
          {headline && <span className="min-w-0 truncate" title={headline}>{kind === 'agent' && item.kind === 'tool' ? <SubagentHeadline call={item.call} result={item.result} /> : kind === 'watch' ? headline : `· ${headline}`}</span>}
          {kind === 'agent' && item.kind === 'tool' && <span className="self-center"><SubagentModelChip call={item.call} /></span>}
          {kind === 'watch' && item.kind === 'tool' && <span className="self-center"><WatchClockChip call={item.call} result={item.result} /></span>}
          {quietSince !== undefined && <ToolProgressChip since={quietSince} />}
        </button>
        {kind === 'agent' && item.kind === 'tool' && <SubagentOpenButton call={item.call} />}
      </div>
      {then && <WatchThen text={then} className="pl-[110px]" />}
      {open && (
        kind === 'agent' && item.kind === 'tool' ? (
          <div className="ml-[84px] space-y-2 py-1">
            <div className="text-ink-soft">Task</div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-ink-soft">{typeof item.call.input.task === 'string' ? item.call.input.task : JSON.stringify(item.call.input, null, 2)}</pre>
            <div className="text-ink-soft">{item.result?.isError ? 'Delegation tool error' : item.result ? 'Delegation tool result' : 'No delegation tool result recorded'}</div>
            {item.result && <div className="max-h-60 overflow-auto font-sans text-[13px] text-ink-soft"><Markdown text={item.result.output} /></div>}
          </div>
        ) : kind === 'watch' && item.kind === 'tool' ? (
          <div className="ml-[84px]"><WatchDetail call={item.call} result={item.result} /></div>
        ) : item.kind === 'note' ? (
          <div className="ml-[84px] border-l border-line py-0.5 pl-2 font-sans text-[13px] text-ink-soft">
            <Markdown text={item.text} />
          </div>
        ) : (
          <pre className="ml-[84px] mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap border-l border-line pl-2 text-[12px] leading-relaxed text-ink-faint">
            {item.kind === 'reasoning' ? item.text : JSON.stringify(item.call.input, null, 2)}
          </pre>
        )
      )}
    </li>
  );
}
