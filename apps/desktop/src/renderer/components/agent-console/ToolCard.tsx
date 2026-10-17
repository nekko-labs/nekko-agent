import { useState } from 'react';
import type { ToolCall } from '@nekko-agent/shared';
import { SubagentCue, SubagentModelChip, useSubagentSummary, SubagentOpenButton } from './SubagentCue.js';
import { WatchClockChip, WatchDetail, WatchIcon, WatchThen, watchCallHeadline } from './WatchRow.js';
import { parseWatchCall, thenSummary } from '../../agentWatches.js';

/**
 * One tool invocation, collapsed to a single line. Neutral coloring on
 * purpose: danger signaling belongs to the approval flow, not to every bash
 * call, so real warnings keep their weight.
 */
export function ToolCard({ call }: { call: ToolCall }) {
  const summary = useSubagentSummary(call);
  const isSpawn = call.name === 'spawn_agent';
  const isWatch = call.name === 'agent_watch';
  const [open, setOpen] = useState(false);
  const headline = isSpawn ? summary : isWatch ? watchCallHeadline(call) : '';
  const then = isWatch && parseWatchCall(call).action === 'create' ? thenSummary(parseWatchCall(call).prompt) : '';
  return (
    <div className="mt-1 font-mono text-[12px]">
      <div className="flex min-w-0 items-center gap-1">
        <button
          className="flex w-full items-center gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
          {isSpawn && <SubagentCue />}
          {isWatch && <WatchIcon />}
          <span className="min-w-0 truncate font-medium" title={headline || undefined}>{headline || <>Used <span className="font-mono text-ink-soft">{call.name}</span> tool</>}</span>
          {isSpawn && <SubagentModelChip call={call} />}
          {isWatch && <WatchClockChip call={call} />}
        </button>
        {isSpawn && <SubagentOpenButton call={call} />}
      </div>
      {then && <WatchThen text={then} className="pl-[38px]" />}
      {open && (isWatch
        ? <div className="ml-[18px]"><WatchDetail call={call} /></div>
        : <pre className={`ml-[18px] mt-0.5 overflow-x-auto whitespace-pre-wrap text-ink-faint max-h-60 overflow-auto ${isSpawn ? '' : 'border-l border-line pl-2'}`}>{isSpawn && typeof call.input.task === 'string' ? call.input.task : JSON.stringify(call.input, null, 2)}</pre>)}
    </div>
  );
}
