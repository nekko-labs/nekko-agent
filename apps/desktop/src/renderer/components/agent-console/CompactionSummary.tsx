import React, { useState } from 'react';
import type { ChatMessage } from '@nekko-agent/shared';
import { Markdown } from '../Markdown.js';
import { ChevronIcon } from '../../icons.js';

/**
 * Where a chat was compacted: a divider under the turns the summary replaced
 * (they stay readable above it, but are no longer sent to the model), then the
 * summary itself. The latest summary is open, since it is what the model works
 * from now; an older one folds to its divider.
 */
export function CompactionSummary({ message, latest }: { message: ChatMessage; latest: boolean }) {
  const [open, setOpen] = useState(latest);
  const count = message.compaction?.summarized ?? 0;
  const when = new Date(message.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="my-1" data-compaction={latest ? 'latest' : 'earlier'}>
      <div className="flex items-center gap-2 text-2xs text-ink-faint" role="separator" aria-label="Earlier conversation compacted">
        <span className="h-px flex-1 bg-line" />
        <button
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 hover:bg-surface-2 hover:text-ink"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={`Compacted ${when}. The messages above are no longer sent to the model.`}
        >
          <ChevronIcon className={`h-3 w-3 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          {count > 0 ? `${count} earlier message${count === 1 ? '' : 's'} compacted` : 'Earlier conversation compacted'}
        </button>
        <span className="h-px flex-1 bg-line" />
      </div>
      {open && (
        <div className="mt-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
          <p className="mb-1 text-xs font-medium text-ink-soft">
            {latest ? 'Summary the model continues from' : 'Earlier summary'}
          </p>
          <div className="text-ink-soft">
            <Markdown text={message.content} />
          </div>
        </div>
      )}
    </div>
  );
}
