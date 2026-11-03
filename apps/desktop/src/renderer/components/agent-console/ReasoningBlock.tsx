import { createContext, useContext } from 'react';
import { ThoughtIcon } from '../../icons.js';
import { Markdown } from '../Markdown.js';
import { useRowState } from './rowState.js';

/**
 * True when the chat runs on a local model. Local models send their whole raw
 * chain of thought rather than a short summary, so a finished thought folds to
 * one "Thought for Xs" row instead of taking over the transcript.
 */
export const FoldThoughtsContext = createContext(false);

/** Provider-supplied thought text, visible without opening an activity row. */
export function ReasoningBlock({ text, live, duration, stateKey = 'thought-open' }: { text: string; live: boolean; duration: number | null; stateKey?: string }) {
  const fold = useContext(FoldThoughtsContext) && !live;
  // Remembered per row, like a tool group's expansion.
  const [open, setOpen] = useRowState(stateKey, false);
  const label = live ? 'Thinking' : duration != null ? `Thought for ${duration}s` : 'Thought';
  if (fold) {
    return (
      <div className="msg-ai mt-2" data-voice="working" data-chat-thought data-folded={!open || undefined}>
        <button className="text-left text-ink-faint hover:text-ink-soft" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ThoughtIcon className="msg-voice-icon" />
          <span className="text-sm">{label}</span>
        </button>
        {open && <div className="mt-1 min-w-0" data-chat-search-text><Markdown text={text} /></div>}
      </div>
    );
  }
  return (
    <div className="msg-ai mt-2" data-voice="working" data-chat-thought aria-label={label}>
      <ThoughtIcon className="msg-voice-icon" />
      <div className="min-w-0" data-chat-search-text><Markdown text={text} /></div>
    </div>
  );
}
