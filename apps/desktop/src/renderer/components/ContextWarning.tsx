import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@nekko-agent/shared';
import { WarningIcon, CloseIcon } from '../icons.js';
import { useStore } from '../store.js';
import { clearCompaction, describeProgress, useCompaction, useCompactionStore } from '../compactionStatus.js';

/** Thresholds as fraction of the context window. */
const WARN_PCT = 95;
const CRITICAL_PCT = 99;

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * In-chat banner shown when the conversation is eating too much of the context
 * window, and while it is being compacted.
 *
 * Past the threshold the chat compacts itself once the reply finishes: the
 * older turns are summarized, they stay visible above a divider, and only the
 * summary and what follows it are sent from then on. While that runs the
 * banner shows how far it has got and offers to send the summary to a new
 * chat instead, or to stop. A blank new chat is always one click away.
 *
 * Dismissible per-session (localStorage) so it doesn't nag on every render; a
 * running compaction shows regardless.
 */
export function ContextWarning({
  sessionId,
  used,
  windowTokens,
  session,
  streaming,
  onCompacted,
}: {
  sessionId: string;
  used: number;
  windowTokens: number;
  session: Session | null;
  streaming: boolean;
  onCompacted: () => void;
}) {
  const pct = windowTokens ? (used / windowTokens) * 100 : 0;
  const dismissedKey = `nekko.ctxDismissed.${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissedKey) !== null; } catch { return false; }
  });
  const progress = useCompaction(sessionId);
  const running = progress?.state === 'running';
  // A request that failed before the host started a job (no progress event).
  const [startError, setStartError] = useState('');
  const autoStarted = useRef(false);

  /** Start (or, with `newChat`, redirect) a compaction and follow it to the end. */
  const compact = useCallback(async (newChat: boolean) => {
    setStartError('');
    try {
      const landed = await window.nekko.compactSession(sessionId, newChat ? { newChat: true } : undefined);
      void useStore.getState().refreshSessions().catch(() => {});
      if (landed.id !== sessionId) useStore.getState().openChatPane(landed.id);
      else onCompacted();
    } catch (error) {
      // A stop or a failure of a started run is already on the banner through
      // its progress event; a request refused before it started is not.
      const p = useCompactionStore.getState().bySession[sessionId];
      if (!p || p.state === 'done') setStartError((error as Error).message || 'Compaction failed.');
    }
  }, [onCompacted, sessionId]);

  useEffect(() => {
    if (pct < WARN_PCT) {
      autoStarted.current = false;
      // Back under the line: the next crossing may compact again.
      if (progress && progress.state !== 'running') clearCompaction(sessionId);
      return;
    }
    // Once per crossing, and never over a compaction this chat already had this
    // launch: one that was stopped or failed waits for the user.
    if (streaming || session?.incognito || session?.queue?.length || !session?.messages.length || autoStarted.current || progress) return;
    autoStarted.current = true;
    void compact(false);
  }, [pct >= WARN_PCT, streaming, session?.incognito, session?.queue?.length, session?.messages.length, progress, compact]);

  if (!running && (pct < WARN_PCT || dismissed)) return null;

  const isCritical = pct >= CRITICAL_PCT && !running;
  const remaining = Math.max(0, windowTokens - used);
  const freePct = windowTokens ? ((remaining / windowTokens) * 100).toFixed(0) : '0';
  const steps = progress ? describeProgress(progress) : null;
  const failed = progress?.state === 'failed' ? progress.error ?? 'Compaction failed.' : startError;

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissedKey, '1'); } catch { /* best effort */ }
  };

  const stop = () => void window.nekko.cancelSessionCompaction(sessionId).catch(() => {});

  const openBlankChat = async () => {
    const created = await window.nekko.createSession(session?.workspaceId ?? undefined);
    if (session?.providerId || session?.modelId) {
      const opts: { providerId?: string; modelId?: string; autoModel?: boolean } = {};
      if (session.providerId) opts.providerId = session.providerId;
      if (session.autoModel) opts.autoModel = true;
      else if (session.modelId) opts.modelId = session.modelId;
      await window.nekko.setSessionOptions(created.id, opts).catch(() => {});
    }
    if (session?.supportingWorkspaceIds?.length) {
      await window.nekko.setSessionSupportingWorkspaces(created.id, session.supportingWorkspaceIds).catch(() => {});
    }
    useStore.getState().refreshSessions();
    useStore.getState().openChatPane(created.id);
  };

  const status = running
    ? progress.target === 'new'
      ? 'The summary will open in a new chat when it is ready. This chat stays as it is.'
      : 'Summarizing the older turns. They stay above a divider; only the summary and newer turns are sent from here on.'
    : failed
      ? `Compaction failed: ${failed}`
      : progress?.state === 'cancelled'
        ? 'Compaction stopped. The conversation is unchanged.'
        : streaming
          ? 'This chat compacts itself after this reply finishes.'
          : remaining > 0
            ? `About ${freePct}% estimated headroom; actual provider usage can differ.`
            : 'The estimate exceeds the listed window. Provider token accounting can differ; if replies still work, this is not a hard limit.';

  return (
    <div
      className={`fade-in mx-auto w-full max-w-3xl rounded-xl border px-4 py-3 text-xs ${isCritical ? 'border-(--danger)/30' : 'border-line'}`}
      style={{ background: isCritical ? 'color-mix(in srgb, var(--danger) 6%, transparent)' : 'var(--surface-2)' }}
      role={running ? 'status' : 'alert'}
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <WarningIcon className={`mt-0.5 h-4 w-4 shrink-0 ${isCritical ? 'text-(--danger)' : 'text-ink-faint'}`} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{running ? 'Compacting this chat' : 'Context window is getting full'}</p>
          <p className="mt-0.5 text-ink-soft">
            {!running && (
              <>
                Estimated prompt size: <span className="tabular-nums font-medium">{fmt(used)}</span> of{' '}
                <span className="tabular-nums">{fmt(windowTokens)}</span> tokens (<span className="tabular-nums">{Math.round(pct)}%</span>).{' '}
              </>
            )}
            {status}
          </p>
          {running && steps && (
            <div className="mt-2">
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-paper"
                role="progressbar"
                aria-label="Compaction progress"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
              >
                {/* A sliver while nothing has finished, so a started run never looks idle. */}
                <div
                  className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-200 ease-(--ease-out)"
                  style={{ transform: `scaleX(${Math.max(0.04, steps.fraction)})` }}
                />
              </div>
              <p className="mt-1 text-2xs tabular-nums text-ink-faint">{steps.label}</p>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {running ? (
              <>
                {progress.target !== 'new' && (
                  <button
                    className="btn btn-primary h-7 px-3 text-2xs"
                    onClick={() => void compact(true)}
                    title="Finish the summary, then start a new chat from it and leave this chat as it is"
                  >
                    Send summary to new chat
                  </button>
                )}
                <button className="btn btn-outline h-7 px-3 text-2xs" onClick={stop} title="Stop summarizing and keep the conversation as it is">
                  Stop compacting
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary h-7 px-3 text-2xs"
                  onClick={() => void compact(false)}
                  title="Summarize the older turns and keep going in this chat"
                >
                  {failed ? 'Retry compaction' : 'Compact now'}
                </button>
                <button
                  className="btn btn-outline h-7 px-3 text-2xs"
                  onClick={() => void compact(true)}
                  title="Summarize this conversation into a new chat and leave this one as it is"
                >
                  Send summary to new chat
                </button>
                <button
                  className="btn btn-outline h-7 px-3 text-2xs"
                  onClick={openBlankChat}
                  title="Open a blank chat with the same workspace, provider, and model"
                >
                  New chat
                </button>
              </>
            )}
          </div>
        </div>
        {!running && (
          <button className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink" title="Dismiss" onClick={dismiss}>
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
