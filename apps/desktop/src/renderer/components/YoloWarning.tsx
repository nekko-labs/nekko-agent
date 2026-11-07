import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from './primitives/Modal.js';
import { useStore } from '../store.js';

/**
 * What YOLO means for data (decision 0054): it never asks, so the egress gate
 * that asks before data leaves a chat that read the web or a tool is off too.
 */
export const YOLO_WARNING =
  'The agent will run commands, edit files, fetch addresses and call tools without asking you first. A web page, search result or tool output it reads can carry instructions, and in YOLO nothing stops them from sending your files or data out of this computer. Your deny rules still block.';

let pending = false;

/**
 * Ask before turning YOLO on, unless the user chose not to be warned again
 * (`skipYoloWarning`, Settings > General). Resolves true to go ahead.
 */
export async function confirmYolo(): Promise<boolean> {
  if (pending) return false;
  if (useStore.getState().settings?.skipYoloWarning === true) return true;
  pending = true;
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const previous = document.activeElement;
    const finish = (approved: boolean) => {
      root.unmount();
      host.remove();
      pending = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(approved);
    };
    root.render(<YoloWarning finish={finish} />);
  });
}

/** Turn YOLO on only when `next` is YOLO and `current` is not, after the warning. */
export async function allowModeChange(current: string | undefined, next: string): Promise<boolean> {
  return next !== 'yolo' || current === 'yolo' || confirmYolo();
}

export function YoloWarning({ finish }: { finish: (approved: boolean) => void }) {
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  return <Modal title="Turn on YOLO?" labelledBy="yolo-warning-title" description={YOLO_WARNING} onClose={() => { if (!busy) finish(false); }} closeOnEscape={!busy} closeOnScrimClick={false} zIndex={100} className="card mx-4 w-full max-w-md p-5">
      <h2 id="yolo-warning-title" className="font-semibold">Turn on YOLO?</h2>
      <p id="yolo-warning-message" className="mt-3 text-sm text-ink-soft">{YOLO_WARNING}</p>
      <p className="mt-2 text-xs text-ink-faint">Guardrails asks only when it matters, and is the recommended mode.</p>
      <label className="mt-4 flex items-center gap-2 text-xs"><input type="checkbox" checked={skip} disabled={busy} onChange={(e) => setSkip(e.target.checked)} />Don't warn me again</label>
      <p className="mt-1 text-2xs text-ink-faint">You can turn the warning back on in Settings.</p>
      <div className="mt-5 flex justify-end gap-2">
        <button autoFocus disabled={busy} className="btn btn-outline" onClick={() => finish(false)}>Keep asking</button>
        <button disabled={busy} className="btn btn-primary" onClick={async () => {
          setBusy(true);
          try {
            if (skip) {
              const settings = await window.nekko.updateSettings({ skipYoloWarning: true });
              useStore.setState({ settings });
            }
            finish(true);
          } catch (error) {
            useStore.getState().pushToast('error', `Could not save the warning preference: ${String(error)}`);
            setBusy(false);
          }
        }}>Turn on YOLO</button>
      </div>
  </Modal>;
}
