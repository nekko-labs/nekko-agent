import { Fragment, memo, useMemo } from 'react';
import { estimateTokens } from '@nekko-agent/shared';
import { useLiveRun, type LiveRun } from '../../liveRuns.js';
import { usePaneVisible } from '../../paneVisibility.js';
import { ActivityGroup } from './ActivityGroup.js';
import { MessageBubble } from './MessageBubble.js';

/**
 * The reply being written right now: its working steps and its text, read
 * straight off the app-wide live run (liveRuns.ts), which repaints at most once
 * an animation frame. This is the only part of a chat that re-renders per
 * token; the transcript above it and the pane around it do not.
 *
 * `held` is the run that just finished, kept on screen until the pane has the
 * persisted reply to replace it with, so the end of a turn never flashes.
 */
export const LiveTurn = memo(function LiveTurn({
  sessionId,
  held,
  onImageClick,
  pendingCallId,
}: {
  sessionId: string;
  held: LiveRun | null;
  onImageClick?: (src: string) => void;
  /** The call waiting for approval, which stays out of the purpose groups. */
  pendingCallId?: string;
}) {
  // A hidden pane stops repainting the reply until it is shown again.
  const live = useLiveRun(sessionId, !usePaneVisible());
  const run = live ?? held ?? undefined;
  if (!run) return null;
  return (
    <>
      {run.blocks.map((block, i) => (
        <Fragment key={i}>
          {block.kind === 'activity'
            ? <ActivityGroup items={block.items} streaming={!!live && i === run.blocks.length - 1} turnRunning={!!live} toolActivity={live?.activity} pendingCallId={pendingCallId} />
            : <MessageBubble message={{ id: `live_${i}`, role: 'assistant', content: block.text, createdAt: 0 }} onImageClick={onImageClick} chronological />}
        </Fragment>
      ))}
    </>
  );
});

/** Tokens a run has produced: what the next request will replay, and what it has output. */
export function producedTokens(run: LiveRun | undefined): { context: number; output: number } {
  if (!run) return { context: 0, output: 0 };
  const text = run.text ? estimateTokens(run.text) : 0;
  const reasoning = run.reasoning ? estimateTokens(run.reasoning) : 0;
  let calls = 0;
  for (const c of run.tools) calls += estimateTokens(c.name) + estimateTokens(JSON.stringify(c.input ?? {}));
  return { context: text + calls, output: text + reasoning };
}

/**
 * What a streaming turn has produced, for the gauges that count it, from the
 * same once-a-frame run the live turn renders from.
 */
export function useProducedTokens(sessionId: string): { context: number; output: number } {
  const run = useLiveRun(sessionId, !usePaneVisible());
  return useMemo(() => producedTokens(run), [run]);
}
