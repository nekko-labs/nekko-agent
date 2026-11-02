import type { ToolCall, ToolResult } from '@nekko-agent/shared';
import { MemoryColorIcon } from '../../navIcons.js';
import { useStore, viewEnabled } from '../../store.js';

/** What a successful `remember` call saved, or null for a failed or unfinished one. */
export function parseMemorySave(call: ToolCall, result?: ToolResult): { action: 'added' | 'updated'; title: string; body: string } | null {
  const action = /^Memory (added|updated):/.exec(result?.output ?? '')?.[1];
  if (call.name !== 'remember' || result?.isError || !action) return null;
  const text = (k: string) => (typeof call.input[k] === 'string' ? (call.input[k] as string).trim() : '');
  return { action: action as 'added' | 'updated', title: text('title'), body: text('body') };
}

/**
 * The card a chat shows when the agent saves something it learned about the
 * user: what changed, and a way to go look at it. Outside the folded step list
 * on purpose, so a finished turn still says it wrote to memory.
 */
export function MemoryCard({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const saved = parseMemorySave(call, result);
  const memoryOn = useStore((s) => viewEnabled('memory', s.settings));
  if (!saved) return null;
  const open = () => {
    if (memoryOn) useStore.setState({ memoryFocus: saved.title });
    useStore.getState().setView(memoryOn ? 'memory' : 'settings');
  };
  return (
    <div className="mt-1 flex max-w-xl items-start gap-3 rounded-xl border border-line px-3 py-2 font-sans" role="status">
      <MemoryColorIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-faint">{saved.action === 'added' ? 'Memory added' : 'Memory updated'}</div>
        <div className="truncate text-sm font-medium text-ink-soft">{saved.title}</div>
        <p className="line-clamp-2 text-xs text-ink-faint">{saved.body}</p>
      </div>
      <button className="shrink-0 self-center text-xs font-medium text-accent hover:underline" onClick={open}>
        {memoryOn ? 'View in Memory' : 'Turn on Memory to view'}
      </button>
    </div>
  );
}
