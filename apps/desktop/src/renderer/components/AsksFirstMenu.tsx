import React from 'react';
import { createPortal } from 'react-dom';
import { getExecutionMode, type ChatMode, type Session } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { saveSettings } from '../settingsIndex.js';
import { CheckIcon, HandIcon, ShieldCheckIcon, YoloIcon } from '../icons.js';
import { usePopover } from './ModeViews.js';
import { allowModeChange } from './YoloWarning.js';

/** The tool policy in plain words. Same values and behaviour as Expert's Mode panel; its Approvals tiles' icons, except the hands-up emoji for yolo. */
export const ASKS_FIRST: ReadonlyArray<{ mode: ChatMode; label: string; hint: string; icon: (p: { className?: string }) => React.ReactElement }> = [
  { mode: 'ask', label: 'Asks first', hint: 'Checks with you before it changes a file or runs a command.', icon: HandIcon },
  { mode: 'guardrails', label: 'Asks when it matters', hint: 'Reads and looks around freely, and asks before anything else.', icon: ShieldCheckIcon },
  { mode: 'yolo', label: 'Works on its own', hint: 'Runs everything, except what your rules block.', icon: YoloIcon },
];

/** Wide enough that each hint sits on one line; the floating menu narrows it to fit a small window. */
export const ASKS_MENU_WIDTH = 400;

/** Simple's view of the tool policy: one choice, in the row under the message box. */
export function AsksFirstMenu({ session, onChange }: { session: Session; onChange: (s: Session | null) => void }) {
  const fallback = useStore((s) => s.settings?.defaultChatMode);
  const pop = usePopover(ASKS_MENU_WIDTH);
  // A sandbox always asks, so there is nothing to choose there.
  const sandbox = getExecutionMode(session) === 'sandbox';
  const mode: ChatMode = sandbox ? 'ask' : session.mode ?? fallback ?? 'guardrails';
  const current = ASKS_FIRST.find((o) => o.mode === mode) ?? ASKS_FIRST[1];
  const pick = async (next: ChatMode) => {
    pop.setOpen(false);
    if (next === mode) return;
    if (!await allowModeChange(mode, next)) return;
    try {
      const updated = await window.nekko.setSessionOptions(session.id, { mode: next });
      onChange(updated);
      if (updated) await saveSettings({ defaultChatMode: next });
    } catch (e) { useStore.getState().pushToast('error', String(e)); }
  };
  return (
    <>
      <button ref={pop.anchor} type="button" className="ctl-menu min-w-0 whitespace-nowrap" data-asks-first={mode} disabled={sandbox} aria-haspopup="menu" aria-expanded={pop.open} title={sandbox ? 'A sandbox always asks first' : current.hint} onClick={() => pop.setOpen((o) => !o)}>
        <current.icon className="h-3 w-3 shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate text-ink">{current.label}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {pop.open && createPortal(
        <div ref={pop.pop} style={pop.style} className="card fixed z-[100] p-1 shadow-(--shadow-float)" role="menu" aria-label="When the agent asks you" data-asks-menu>
          {ASKS_FIRST.map((o) => (
            <button key={o.mode} type="button" role="menuitemradio" aria-checked={o.mode === mode} className="flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-2" onClick={() => void pick(o.mode)}>
              <span className="mt-0.5 shrink-0 text-ink-faint" data-mode-icon={o.mode} aria-hidden="true"><o.icon className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-ink">{o.label}</span>
                <span className="block text-2xs text-ink-faint">{o.hint}</span>
              </span>
              {o.mode === mode && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
