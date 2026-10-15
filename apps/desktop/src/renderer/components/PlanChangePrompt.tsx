import React, { useEffect, useRef, useState } from 'react';
import { PLAN_CHANGE_REQUEST } from './PlanRail.js';

/** What the agent receives: the standing request, then what the user typed. */
export function planChangeMessage(change: string): string {
  return `${PLAN_CHANGE_REQUEST}${change.trim()}`;
}

/**
 * "Change plan", asked the way the agent asks its own questions: a card that
 * pops up where questions do, with one box to say what should change.
 *
 * It used to drop a sentence into the composer's draft. On the Agents wall the
 * plan rail belongs to the window's transcript and the composer is a separate
 * pane, so that draft was never on screen and the button looked dead.
 */
export function PlanChangePrompt({ onSend, onCancel, running }: {
  onSend: (change: string) => void;
  onCancel: () => void;
  /** A running agent takes the change at its next step instead of a new turn. */
  running: boolean;
}) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const ready = !!text.trim();
  const send = () => { if (ready) onSend(text); };
  return (
    <div
      className="rounded-xl border p-3"
      data-plan-change
      role="group"
      aria-label="Change the agent's plan"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)', background: 'var(--accent-soft)' }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>Change the plan</span>
        <span className="ml-auto text-[10.5px] text-ink-faint">{running ? 'applies at its next step' : 'starts a new turn'}</span>
      </div>
      <label className="mb-1.5 block text-[12.5px] font-medium text-ink" htmlFor="plan-change-text">What should the agent do differently?</label>
      <textarea
        id="plan-change-text"
        ref={box}
        className="input min-h-[64px] w-full resize-y py-1.5 text-[12.5px] leading-snug"
        rows={3}
        placeholder="For example: skip the migration, and add tests before refactoring."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={`btn px-2.5 py-1 text-[12px] ${ready ? 'btn-primary' : 'btn-outline'}`} disabled={!ready} onClick={send}>Send change</button>
        <span className="truncate text-[10px] text-ink-faint">↵ to send, Shift+↵ for a new line, Esc to cancel</span>
        <button type="button" className="btn btn-ghost ml-auto shrink-0 px-2 py-1 text-[12px]" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
