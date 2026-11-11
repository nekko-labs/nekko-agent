import React from 'react';
import { create } from 'zustand';
import { useStore } from '../store.js';
import { TerminalIcon } from '../icons.js';
import { ExternalIcon, CloseIcon, SendIcon } from '../icons.js';
import { pickChatTerminal, sharedOutputMessage, terminalText } from '../suggestedCommands.js';
import { terminalPresentation } from './terminalActivity.js';
import { TerminalPane } from './TerminalPane.js';

/**
 * Running a command the agent suggested, in the chat's own terminal (#2595).
 *
 * A chat provides `ChatCodeRun` when its replies may run commands: a local
 * chat the user can write in (not a Sandbox chat, whose work never runs on
 * this computer's shell, and not a read-only view). A shell code block in a
 * reply then shows Run. Only that click types anything into a terminal; the
 * agent has no way to press it.
 */
export interface ChatCodeRunTarget {
  sessionId: string;
  /** The chat's folder: where its terminal starts. */
  cwd?: string;
  workspaceId?: string;
  /** Add text to the chat's composer (Share output). */
  share?: (text: string) => void;
}

export const ChatCodeRun = React.createContext<ChatCodeRunTarget | null>(null);

/**
 * Which code block shows the chat's terminal, by chat. One at a time: the
 * terminal moves to the block that ran last, so two views never fight over
 * the shell's size. Kept outside React so a block scrolled out of the
 * virtualized transcript and back still shows it.
 */
interface InlineTerminals {
  /** `ran`: when Run last opened it, so the view brings its block into sight right after (not on a later remount). */
  open: Record<string, { block: string; terminalId: string; ran?: number }>;
  /** The terminal Run used last per chat, preferred while it still runs. */
  last: Record<string, string>;
}
export const useInlineTerminals = create<InlineTerminals>(() => ({ open: {}, last: {} }));

/** Find or open the chat's terminal and type the command into it. Returns the terminal's id. */
export async function runSuggestedCommand(target: ChatCodeRunTarget, block: string, command: string): Promise<string> {
  const store = useStore.getState();
  await store.refreshTerminals();
  const prefer = useInlineTerminals.getState().last[target.sessionId];
  let terminal = pickChatTerminal(useStore.getState().terminals, target.sessionId, prefer);
  if (!terminal) {
    terminal = await window.nekko.createTerminal({ sessionId: target.sessionId, cwd: target.cwd, workspaceId: target.workspaceId, title: 'Chat terminal' });
    await store.refreshTerminals();
  }
  const id = terminal.id;
  useInlineTerminals.setState((s) => ({ open: { ...s.open, [target.sessionId]: { block, terminalId: id, ran: Date.now() } }, last: { ...s.last, [target.sessionId]: id } }));
  await window.nekko.runInTerminal(id, command);
  return id;
}

export function hideInlineTerminal(sessionId: string) {
  useInlineTerminals.setState((s) => {
    const open = { ...s.open };
    delete open[sessionId];
    return { open };
  });
}

/** Run, beside Copy on a shell block. */
export function RunCommandButton({ target, block, command }: { target: ChatCodeRunTarget; block: string; command: string }) {
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runSuggestedCommand(target, block, command);
    } catch (e) {
      useStore.getState().pushToast('error', `Could not run this in a terminal: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const lines = command.split('\r').filter((l) => l.trim()).length;
  return (
    <button
      type="button"
      data-run-command
      className="quiet-tab code-action items-center!"
      disabled={busy}
      title={lines > 1 ? `Run these ${lines} lines in this chat's terminal` : "Run in this chat's terminal"}
      onClick={() => void run()}
    >
      <TerminalIcon className="h-3.5 w-3.5" />
      Run
    </button>
  );
}

/** How long after a Run its view still brings the block into sight. */
const REVEAL_WINDOW_MS = 2000;

/**
 * Scroll the transcript just enough to show the whole block (its top when it
 * is taller than the view). The transcript follows the latest reply until the
 * reader scrolls up, and it decides that on its own scroll event, so the event
 * goes out with the move: a smooth scroll would be undone by the next resize.
 */
function revealBlock(block: HTMLElement) {
  let sc: HTMLElement | null = block.parentElement;
  while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  if (!sc) return;
  const view = sc.getBoundingClientRect();
  const r = block.getBoundingClientRect();
  let delta = 0;
  if (r.top < view.top || r.height > view.height) delta = r.top - view.top - 8;
  else if (r.bottom > view.bottom) delta = r.bottom - view.bottom + 8;
  if (Math.abs(delta) < 1) return;
  sc.scrollTop += delta;
  sc.dispatchEvent(new Event('scroll'));
}

/** The chat's terminal, live under the block that ran it. */
export function InlineChatTerminal({ target, terminalId }: { target: ChatCodeRunTarget; terminalId: string }) {
  const info = useStore((s) => s.terminals.find((t) => t.id === terminalId));
  const p = info ? terminalPresentation(info) : null;
  const ref = React.useRef<HTMLDivElement>(null);
  const ran = useInlineTerminals((s) => s.open[target.sessionId]?.ran);
  // A transcript following the latest reply would push the block that ran up
  // and out of sight as the terminal opens: bring the block back, once per Run.
  React.useEffect(() => {
    // Only for a Run just made: a view remounted by scrolling back leaves the transcript alone.
    if (!ran || Date.now() - ran > REVEAL_WINDOW_MS) return;
    // Two frames: the first lays the opened terminal out and lets the
    // transcript follow the bottom; the second measures where that left the block.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const block = ref.current?.closest<HTMLElement>('[data-code-block]');
        if (block) revealBlock(block);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [ran]);
  const shareOutput = async () => {
    try {
      const snap = await window.nekko.terminalSnapshot(terminalId, { maxBytes: 64 * 1024 });
      const text = terminalText(snap?.buffer ?? '');
      if (!text) {
        useStore.getState().pushToast('info', 'The terminal has no output yet.');
        return;
      }
      target.share?.(sharedOutputMessage(text));
    } catch {
      useStore.getState().pushToast('error', "Couldn't read the terminal's output.");
    }
  };
  return (
    <div ref={ref} data-inline-terminal className="inline-terminal">
      <div className="flex min-w-0 items-center gap-2 px-3 py-1 text-xs">
        <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-soft" />
        <span data-inline-terminal-title className="min-w-0 truncate font-medium text-ink">{p?.title ?? 'Chat terminal'}</span>
        {p && <span className="hidden shrink-0 sm:inline" style={{ color: p.tone }}>{p.status}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {target.share && (
            <button type="button" data-share-output className="quiet-tab code-action items-center!" title="Put the terminal's recent output in your message, so the agent can read it" onClick={() => void shareOutput()}>
              <SendIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Share output</span>
            </button>
          )}
          <button type="button" data-open-terminal className="quiet-tab code-action items-center!" title="Open in a panel" aria-label="Open in a panel" onClick={() => { useStore.getState().openTerminalPane(terminalId); }}>
            <ExternalIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" data-hide-terminal className="quiet-tab code-action items-center!" title="Hide the terminal (it keeps running)" aria-label="Hide the terminal" onClick={() => hideInlineTerminal(target.sessionId)}>
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <div className="h-60">
        <TerminalPane terminalId={terminalId} embedded />
      </div>
    </div>
  );
}
