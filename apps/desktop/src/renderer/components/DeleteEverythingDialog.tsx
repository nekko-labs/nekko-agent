import { useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { Modal } from './primitives/Modal.js';

/** What Delete everything removes from this computer, in the order the dialog lists it. */
export const WIPE_ITEMS = [
  'Chats, with their command logs and the agent browser\'s files',
  'Memory notes, usage and reply history, and limit snapshots',
  'Settings, providers and API keys (settings go back to their defaults)',
  'Sign-ins to providers and connected tools',
  'Automation tasks and workflows',
  'Phone remote access, paired phones and linked computers',
  'Your Nekko Cloud sign-in and sync keys on this computer',
  'Keys this app saved in the macOS Keychain or Windows Credential Manager',
  'Logs and settings backups',
] as const;

/**
 * Delete everything, then forget what the window itself kept (its local and
 * session storage). `models` also deletes downloaded models and runtimes.
 */
export async function wipeEverything(models: boolean, storage: Pick<Storage, 'clear'>[] = [localStorage, sessionStorage]): Promise<AppSettings> {
  const settings = await window.nekko.wipeAllData({ models });
  for (const s of storage) {
    try { s.clear(); } catch { /* storage can be unavailable; the engine's data is what matters */ }
  }
  return settings;
}

/** Settings > Data & privacy > Delete everything: what goes, what stays, and the models choice. */
export function DeleteEverythingDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: (models: boolean) => void }) {
  const [models, setModels] = useState(false);
  return (
    <Modal title="Delete everything" labelledBy="wipe-title" onClose={() => { if (!busy) onCancel(); }} closeOnEscape={!busy} closeOnScrimClick={false} zIndex={100} className="card mx-4 w-full max-w-md p-5">
      <h2 id="wipe-title" className="font-semibold">Delete everything on this computer?</h2>
      <p className="mt-2 text-sm text-ink-soft">Running chats and tasks stop first. Then this deletes:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
        {WIPE_ITEMS.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <p className="mt-3 text-xs text-ink-faint">
        Stays: your Nekko Cloud account and anything synced to it (delete those in Settings &gt; Sync), CI runners (remove them in Automations) and models in folders you chose yourself.
      </p>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" data-wipe-models checked={models} disabled={busy} onChange={(e) => setModels(e.target.checked)} />
        <span>
          Also delete downloaded models and model runtimes
          <span className="block text-2xs text-ink-faint">They can take many gigabytes and hold nothing personal. Leave this off to keep them for next time.</span>
        </span>
      </label>
      <p className="mt-4 text-xs font-medium text-(--danger)">This can't be undone.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button autoFocus className="btn btn-outline" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="btn text-white!" style={{ background: 'var(--danger)' }} data-wipe-confirm disabled={busy} onClick={() => onConfirm(models)}>
          {busy ? 'Deleting…' : 'Delete everything'}
        </button>
      </div>
    </Modal>
  );
}
