import React, { useId, useState } from 'react';
import type { ChatMessage } from '@nekko-agent/shared';
import { Markdown } from '../Markdown.js';
import { ChevronIcon } from '../../icons.js';

/** "41k" / "1M", as the context gauge reads. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * The divider's second line. A Claude Code compaction says why it happened
 * and how far the context fell, so a gauge that dropped from 1M to a few
 * thousand reads as what it is.
 */
function detail(compaction: ChatMessage['compaction']): string {
  const count = compaction?.summarized ?? 0;
  const summarized = count > 0 ? `${count} earlier message${count === 1 ? '' : 's'} summarized` : 'Earlier conversation summarized';
  if (compaction?.by !== 'claude-code') return summarized;
  const why = compaction.trigger === 'auto' ? 'Automatically, near the context limit' : compaction.trigger === 'manual' ? 'On /compact' : '';
  const { tokensBefore: before, tokensAfter: after } = compaction;
  const size = before && after ? `context ${tokens(before)} → ${tokens(after)} tokens` : '';
  return [why, size, summarized].filter(Boolean).join(' · ');
}

/** A compaction event stays collapsed until the user asks to read its summary. */
export function CompactionSummary({ message, latest }: { message: ChatMessage; latest: boolean }) {
  const [open, setOpen] = useState(false);
  const summaryId = useId();
  const byClaudeCode = message.compaction?.by === 'claude-code';
  const when = new Date(message.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-line bg-surface-2" data-compaction={latest ? 'latest' : 'earlier'}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-soft hover:bg-surface-3 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={summaryId}
        title={
          byClaudeCode
            ? `Compacted ${when} by Claude Code. It continues from the summary, not from the messages above.`
            : `Compacted ${when}. The messages above are no longer sent to the model.`
        }
      >
        <ChevronIcon className={`h-3 w-3 shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{byClaudeCode ? 'Claude Code compacted the conversation' : 'Conversation compacted'}</span>
          <span className="block text-2xs text-ink-faint">{detail(message.compaction)}</span>
        </span>
        <span className="shrink-0 text-2xs">{message.content ? (open ? 'Hide summary' : 'Show summary') : ''}</span>
      </button>
      <div id={summaryId} hidden={!open}>
        {open && message.content && (
          <div className="border-t border-line px-4 py-3 text-sm">
            <p className="mb-1 text-xs font-medium text-ink-soft">
              {latest ? 'Summary the model continues from' : 'Earlier summary'}
            </p>
            <div className="text-ink-soft">
              <Markdown text={message.content} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
