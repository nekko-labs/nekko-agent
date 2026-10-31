import { CheckIcon, CopyIcon } from '../../icons.js';
import React, { memo, useState } from 'react';
import type { ChatMessage } from '@nekko-agent/shared';
import { Markdown } from '../Markdown.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { ToolCard } from './ToolCard.js';
import { fmtDateTime, fmtTime } from './transcript.js';
import { useRowState } from './rowState.js';
import { isRecoveryNotice, RecoveryNotice } from './RecoveryNotice.js';
import { isWatchWake } from '../../agentWatches.js';
import { WatchWakeRow } from './WatchRow.js';
import { DoneRow } from './TurnStatsLine.js';

/**
 * One message. Memoized: a transcript row re-renders only when its message (or
 * a handler it was given) actually changes, not on every keystroke or token.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  basePath,
  onResend,
  onReset,
  onCopyToComposer,
  onSplit,
  onDelete,
  onRestart,
  onImageClick,
  onImageContextMenu,
  chronological,
}: {
  message: ChatMessage;
  basePath?: string;
  onResend?: (id: string, text: string) => void;
  /** Rewind the chat to this message and re-run it (replaces the old Regenerate). */
  onReset?: (id: string, text: string) => void;
  /** Put this message's text and images into the composer, to reuse them. */
  onCopyToComposer?: (id: string) => void;
  /** Start a new chat from the conversation before this message, with it in the new composer. */
  onSplit?: (id: string) => void;
  /** Delete this message and the reply it got (offered on the latest user message only). */
  onDelete?: (id: string) => void;
  /** Keep the conversation up to this reply and drop what follows it. */
  onRestart?: (id: string) => void;
  onImageClick?: (src: string) => void;
  onImageContextMenu?: (e: React.MouseEvent, src: string) => void;
  chronological?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Kept per transcript row, so an edit in progress survives the row scrolling
  // out of the window and back.
  const [editing, setEditing] = useRowState('editing', false);
  const isUser = message.role === 'user';
  const displayText = isUser && message.skill ? message.skill.input : message.content;
  const [draft, setDraft] = useRowState('edit-draft', displayText);
  if (message.role === 'tool') return null;
  if (isRecoveryNotice(message)) return <RecoveryNotice />;
  // A watch's wake-up is the agent continuing itself: a step, not your message.
  if (isUser && !editing && isWatchWake(message.content)) return <WatchWakeRow content={message.content} createdAt={message.createdAt} />;
  // Animate only genuinely-new content (the optimistic user bubble and the live
  // stream). Persisted messages render statically, so the optimistic→saved and
  // live→saved swaps at the end of a turn don't replay the entrance.
  // LiveTurn keys its text blocks `live_<n>`, one per narration block of the run.
  const entering = message.id === 'tmp' || message.id === 'live' || message.id.startsWith('live_');
  const copy = () => {
    navigator.clipboard?.writeText(message.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%]">
          {/* The pictures ride along with the edit: Save & send re-sends them. */}
          {message.images?.length ? (
            <div className="mb-1 flex flex-wrap justify-end gap-2" title="These images are sent again with your edit">
              {message.images.map((image, i) => (
                <img key={`${image.slice(0, 24)}-${i}`} src={image} alt={`Attached image ${i + 1}`} className="h-12 w-12 rounded-md object-cover" />
              ))}
            </div>
          ) : null}
          <textarea className="input max-h-48 min-h-[60px] resize-none text-sm" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
          <div className="mt-1 flex justify-end gap-2">
            <button className="btn btn-ghost py-1 text-xs" onClick={() => { setEditing(false); setDraft(displayText); }}>Cancel</button>
            <button className="btn btn-primary py-1 text-xs" onClick={() => { setEditing(false); onResend?.(message.id, draft); }}>Save &amp; send</button>
          </div>
        </div>
      </div>
    );
  }

  // In chronological mode, render reasoning, tools, and text as separate
  // interleaved blocks so the layout is consistent with the live streaming view.
  if (chronological && !isUser) {
    const parts: React.ReactNode[] = [];
    if (message.reasoning) {
      parts.push(<ReasoningBlock key="reasoning" text={message.reasoning} live={false} duration={message.reasoningSeconds ?? null} />);
    }
    if (displayText) {
      parts.push(
        <div key="text" className={`group ${entering ? 'fade-in ' : ''}flex justify-start`}>
          <div className="msg-ai">
            <div data-chat-search-text><Markdown basePath={basePath} text={message.content} /></div>
            {!entering && <DoneRow done={!message.interrupted && !message.toolCalls?.length} stats={message.turnStats} />}
            {displayText && message.content && (
              <div className="mt-1 flex gap-3 text-2xs text-ink-faint opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button onClick={copy} title="Copy message" className="inline-flex items-center gap-1 hover:text-ink">{copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}</button>
                {onRestart && (
                  <button onClick={() => onRestart(message.id)} title="Keep the chat up to this reply and delete everything after it" className="hover:text-ink" data-message-restart>
                    Restart from here
                  </button>
                )}
              </div>
            )}
          </div>
        </div>,
      );
    }
    if (message.toolCalls?.length) {
      message.toolCalls.forEach((c) => parts.push(<ToolCard key={c.id} call={c} />));
    }
    if (message.images?.length) parts.push(<GeneratedImages key="images" message={message} entering={entering} onImageClick={onImageClick} onImageContextMenu={onImageContextMenu} />);
    return <>{parts}</>;
  }

  return (
    <div className={`group ${entering ? 'fade-in ' : ''}flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={isUser ? 'msg-user' : 'msg-ai'}>
        {isUser && message.skill && (
          <span className="skill-pill mb-2 inline-flex text-2xs">
            <span className="skill-pill-slash">/</span>{message.skill.name}
          </span>
        )}
        {isUser && message.videos?.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.videos.map((video, i) => (
              <video
                key={`${video.slice(0, 24)}-${i}`}
                src={video}
                controls
                playsInline
                preload="metadata"
                className="max-h-[220px] max-w-full rounded-lg bg-black"
                title={`Attached video ${i + 1}`}
              />
            ))}
          </div>
        ) : null}
        {isUser && message.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.images.map((image, i) => (
              <img
                key={`${image.slice(0, 24)}-${i}`}
                src={image}
                alt={`Attached image ${i + 1}`}
                className="h-[104px] w-[104px] cursor-pointer rounded-lg object-cover"
                onClick={() => onImageClick?.(image)}
                onContextMenu={(e) => onImageContextMenu?.(e, image)}
                title="Click to preview · right-click to copy or save"
              />
            ))}
          </div>
        ) : null}
        {!isUser && message.reasoning && (
          <ReasoningBlock text={message.reasoning} live={false} duration={message.reasoningSeconds ?? null} />
        )}
        {/* Your own messages render as markdown too: people type dashed lists and
            `code` in the composer and expect them to come out formatted. */}
        {displayText && <div data-chat-search-text><Markdown basePath={basePath} text={isUser ? displayText : message.content} /></div>}
        {message.toolCalls?.map((c) => <ToolCard key={c.id} call={c} />)}
        {!isUser && !entering && <DoneRow done={!message.interrupted && !message.toolCalls?.length} stats={message.turnStats} />}
        {(displayText && message.content || (isUser && (message.images?.length || message.videos?.length))) && (
          <div className={`mt-1 flex items-center gap-3 text-2xs text-ink-faint opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${isUser ? 'justify-end' : ''}`}>
            {isUser && message.createdAt > 0 && (
              <span className="text-ink-faint/70" title={fmtDateTime(message.createdAt)}>{fmtTime(message.createdAt)}</span>
            )}
            <button onClick={copy} title="Copy prompt" className="inline-flex items-center gap-1 hover:text-ink">{copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}{copied ? 'Copied' : 'Copy'}</button>
            {onResend && <button onClick={() => { setDraft(displayText); setEditing(true); }} title="Edit & resend" className="hover:text-ink">Edit</button>}
            {!isUser && onRestart && (
              <button onClick={() => onRestart(message.id)} title="Keep the chat up to this reply and delete everything after it" className="hover:text-ink" data-message-restart>
                Restart from here
              </button>
            )}
            {onReset && (
              <button
                onClick={() => onReset(message.id, displayText)}
                title="Rewind the chat to this message and re-run it (its images are sent again)"
                className="hover:text-ink"
              >
                Reset here
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(message.id)}
                title="Delete this message and the reply it got, for example a picture this model cannot take"
                className="hover:text-[var(--danger)]"
                data-message-delete
              >
                Delete
              </button>
            )}
            {onSplit && (
              <button
                onClick={() => onSplit(message.id)}
                title="Start a new chat with the conversation before this message, and this message (with its images) waiting in its message box"
                className="hover:text-ink"
              >
                Split here
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * The picture an image chat made, at a readable size, with how it was made
 * underneath: enough to reproduce it (model, size, steps, CFG and the seed
 * actually used) and to see what it cost in time.
 */
function GeneratedImages({ message, entering, onImageClick, onImageContextMenu }: {
  message: ChatMessage;
  entering: boolean;
  onImageClick?: (src: string) => void;
  onImageContextMenu?: (e: React.MouseEvent, src: string) => void;
}) {
  const g = message.generated;
  const model = g?.modelId.split('/').pop();
  return (
    <div className={`${entering ? 'fade-in ' : ''}flex flex-col items-start gap-2`}>
      {message.images!.map((image, i) => (
        <img
          key={`${message.id}-${i}`}
          src={image}
          alt={g ? `Generated image, ${g.width}×${g.height}` : 'Generated image'}
          className="h-auto w-full max-w-[512px] cursor-pointer rounded-xl border border-line"
          style={g ? { aspectRatio: `${g.width} / ${g.height}` } : undefined}
          onClick={() => onImageClick?.(image)}
          onContextMenu={(e) => onImageContextMenu?.(e, image)}
          title="Click to preview · right-click to copy or save"
        />
      ))}
      {g && (
        <p className="text-2xs text-ink-faint">
          {model} · {g.width}×{g.height} · {g.steps} steps · CFG {g.cfgScale} · seed {g.seed} · {(g.ms / 1000).toFixed(1)}s
        </p>
      )}
    </div>
  );
}
