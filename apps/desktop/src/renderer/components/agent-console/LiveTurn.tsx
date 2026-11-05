import { Fragment, memo, useMemo } from 'react';
import { estimateTokens } from '@nekko-agent/shared';
import { useLiveRun, type LiveRun } from '../../liveRuns.js';
import { usePaneVisible } from '../../paneVisibility.js';
import { ActivityGroup } from './ActivityGroup.js';
import { MessageBubble } from './MessageBubble.js';
import { midTurnVoice, withLivePrSteps } from './transcript.js';
import { PrCard } from '../PrCard.js';
import type { PrInfo } from '@nekko-agent/shared';

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
  knownPrUrls = [],
  prByUrl,
}: {
  sessionId: string;
  held: LiveRun | null;
  onImageClick?: (src: string) => void;
  /** The call waiting for approval, which stays out of the purpose groups. */
  pendingCallId?: string;
  /** The chat's PRs so far, to name the PR a silent `gh pr merge 12` acted on. */
  knownPrUrls?: string[];
  prByUrl?: Map<string, PrInfo>;
}) {
  // A hidden pane stops repainting the reply until it is shown again.
  const live = useLiveRun(sessionId, !usePaneVisible());
  const run = live ?? held ?? undefined;
  if (!run) return null;
  // The newest text has no voice yet: it may be a note or the reply. Its look
  // settles once more follows it or the turn ends, and neither re-wraps it.
  const last = run.blocks.length - 1;
  // PR steps the turn has confirmed sit right after the call that took them.
  const pieces = withLivePrSteps(run.blocks.map((block, at) => ({ ...block, at })), run.tools, run.ghResults, knownPrUrls);
  return (
    <>
      {pieces.map((piece, n) => {
        if (piece.kind === 'pr') return <PrCard key={piece.key} url={piece.url} info={prByUrl?.get(piece.url)} event={piece.event} sessionId={sessionId} />;
        const { block } = piece;
        const i = block.at;
        // Only the newest piece of the newest block is still being written.
        const newest = n === pieces.length - 1 && i === last;
        return (
          <Fragment key={i + '_' + n}>
            {block.kind === 'activity'
              ? <ActivityGroup items={block.items} streaming={!!live && newest} turnRunning={!!live} toolActivity={live?.activity} pendingCallId={pendingCallId} />
              : <MessageBubble message={{ id: `live_${i}`, role: 'assistant', content: block.text, createdAt: 0 }} voice={i < last ? midTurnVoice(block.text) : !live && run.tools.length ? 'reply' : undefined} onImageClick={onImageClick} chronological />}
          </Fragment>
        );
      })}
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
