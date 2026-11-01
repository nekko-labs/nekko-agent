import React from 'react';
import { runnerWorkflowPrompt, type RunnerView } from '@nekko-agent/shared';
import { useStore } from '../store.js';

/**
 * Opens a new chat with the message waiting in its composer. Nothing is sent:
 * the person reads it and presses Send.
 */
export async function connectToWorkflow(view: RunnerView): Promise<void> {
  const { activeSessionId: before, setView, newChat, seedComposer, pushToast } = useStore.getState();
  setView('command');
  try {
    await newChat();
  } catch (e) {
    pushToast('error', `Could not open a new chat: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const { activeSessionId } = useStore.getState();
  // With no model set up, `newChat` opens Model setup and makes no chat, so the active one is still an old chat.
  if (!activeSessionId || activeSessionId === before) {
    pushToast('info', 'Set up a model first. Connect to a workflow stays on the runner card.');
    return;
  }
  seedComposer(activeSessionId, runnerWorkflowPrompt(view), []);
}

const SPARKS = [
  ['0deg', 'var(--accent)'], ['48deg', 'var(--success)'], ['95deg', 'var(--warning)'], ['140deg', 'var(--accent)'],
  ['186deg', 'var(--success)'], ['232deg', 'var(--warning)'], ['278deg', 'var(--accent)'], ['322deg', 'var(--success)'],
];

/**
 * Frame 8. `on` is the runner as the daemon has it: a finished build leaves a
 * public repo's runner off until fork approval is settled, and that is no moment to celebrate.
 */
export function RunnerReady({ on, onDone, onWorkflow }: { on: boolean; onDone(): void; onWorkflow(): void }) {
  if (!on) {
    return (
      <div className="flex flex-col items-center gap-3.5 px-5 pt-6.5 pb-5 text-center">
        <h2 className="text-lg font-semibold text-ink">The VM image is ready</h2>
        <p className="text-sm text-ink-soft">
          The runner is off. A public repo stays off until GitHub holds outside contributors for approval: turn that on in its Actions settings, then choose Connect GitHub to finish.
        </p>
        <button type="button" className="btn btn-outline" onClick={onDone}>Done</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3.5 px-5 pt-6.5 pb-5 text-center">
      <div className="runner-burst" aria-hidden="true">
        <span className="ring" />
        {SPARKS.map(([a, c]) => <i key={a} style={{ '--a': a, '--c': c } as React.CSSProperties} />)}
        <span className="badge">
          <svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      </div>
      <h2 className="text-[21px] font-semibold tracking-[-.01em] text-ink">This Mac is ready</h2>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" className="btn btn-outline" onClick={onDone}>Done</button>
        <button type="button" className="btn btn-primary" onClick={onWorkflow}>Connect to a workflow now</button>
      </div>
    </div>
  );
}
