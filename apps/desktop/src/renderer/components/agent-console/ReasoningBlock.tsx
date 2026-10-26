import { ThoughtIcon } from '../../icons.js';
import { Markdown } from '../Markdown.js';

/** Provider-supplied thought text, visible without opening an activity row. */
export function ReasoningBlock({ text, live, duration }: { text: string; live: boolean; duration: number | null }) {
  return (
    <div className="msg-ai mt-2 flex items-start gap-2" data-chat-thought aria-label={live ? 'Thinking' : duration != null ? `Thought for ${duration}s` : 'Thought'}>
      <ThoughtIcon className="mt-1 h-4 w-4 shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1" data-chat-search-text><Markdown text={text} /></div>
    </div>
  );
}
