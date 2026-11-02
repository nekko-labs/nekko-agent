import React, { useState, useEffect, useRef } from 'react';

function useDialogFocus(onClose: () => void, busy: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const pending = useRef(busy);
  pending.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
    (controls()[0] ?? dialog)?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!pending.current) close.current();
      }
      if (event.key === 'Tab') {
        const items = controls();
        const index = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        (items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length] ?? dialog)?.focus({ preventScroll: true });
      }
    };
    const focus = (event: FocusEvent) => {
      if (dialog && !dialog.contains(event.target as Node)) (controls()[0] ?? dialog).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
import { createPortal } from 'react-dom';
import type { Session, SandboxDiff } from '@nekko-agent/shared';
import { useStore } from '../store.js';

export const SANDBOX_APPLY_BLOCKER = 'Apply-back is unavailable: the host API is fail-closed until safe conflict checking and application are implemented.';
export function isPinnedSandboxImage(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(image.trim());
}

/** Setup only uses an already-local, digest-pinned image. Never offers a pull. */
export function SandboxSetup({ session, onChange, onClose }: { session: Session; onChange: (s: Session | null) => void; onClose: () => void }) {
  const [image, setImage] = useState(session.sandbox?.image ?? '');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogFocus(onClose, busy);
  const configure = async () => {
    setBusy(true); setError('');
    try {
      const status = await window.nekko.configureSandbox(session.id, image.trim());
      if (status.phase === 'error' || status.phase === 'unconfigured') throw new Error(status.error ?? 'Sandbox was not configured.');
      const next = await window.nekko.setSessionOptions(session.id, { executionMode: 'sandbox', mode: 'ask' });
      onChange(next);
      await window.nekko.updateSettings({ defaultExecutionMode: 'sandbox' });
      await useStore.getState().refreshSettings();
      onClose();
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="fixed inset-0 z-[110] grid place-items-center bg-black/30" role="presentation">
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Set up Sandbox" className="card mx-4 w-[480px] max-w-full space-y-3 p-5 shadow-(--shadow-float)">
      <h2 className="font-medium">Set up Sandbox</h2>
      <p className="text-sm text-ink-soft">Use an already-local container image pinned by SHA-256 digest. No images will be pulled. Sandbox supports scoped files and bash only. Setup starts with fresh Ask permissions.</p>
      {session.sandbox && <p className="text-sm text-ink-soft">This sandbox identity is immutable. After a restart, Review sandbox diff verifies and reconnects to a running owned container. Failed or stopped sandboxes must be cleaned up, then continued in a new sandbox chat. Cleanup permanently deletes the copied files, not the source folders.</p>}
      {session.sandbox && <button className="ctl-menu" disabled={busy || !consent} onClick={async () => {
        setBusy(true); setError('');
        try { await window.nekko.cleanupSandbox(session.id, session.sandbox!.identity); setError('Sandbox resources deleted. Create a new sandbox chat to resume.'); }
        catch (e) { setError(String((e as Error).message ?? e)); }
        finally { setBusy(false); }
      }}>Delete sandbox resources</button>}
      <label className="block text-sm">Local image digest<input className="input mt-1 w-full" value={image} onChange={(e) => setImage(e.target.value)} placeholder="image@sha256:…" /></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{session.sandbox ? 'I understand cleanup permanently deletes this sandbox copy, including unsaved changes.' : "I consent to copying this chat's scoped folders into a local sandbox."}</label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button className="ctl-menu" disabled={busy} onClick={onClose}>Cancel</button><button className="ctl-menu" disabled={busy || !!session.sandbox || !consent || !isPinnedSandboxImage(image)} onClick={() => void configure()}>{busy ? 'Configuring…' : 'Configure Sandbox'}</button></div>
    </div>
  </div>, document.body);
}

function ReviewDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useDialogFocus(onClose, false);
  return createPortal(<div className="fixed inset-0 z-[110] grid place-items-center bg-black/30"><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Sandbox diff review" className="card max-h-[80vh] w-[600px] max-w-[95vw] overflow-auto space-y-3 p-5">{children}</div></div>, document.body);
}

export function SandboxReview({ sessionId }: { sessionId: string }) {
  const [diff, setDiff] = useState<SandboxDiff | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  return <><button className="ctl-menu" onClick={async () => { setOpen(true); setDiff(null); setError(''); try { setDiff(await window.nekko.sandboxDiff(sessionId)); } catch (e) { setError(String((e as Error).message ?? e)); } }}>Review sandbox diff</button>
    {open && <ReviewDialog onClose={() => setOpen(false)}>
      <h2>Sandbox diff (read-only)</h2><p className="text-sm text-ink-soft">{SANDBOX_APPLY_BLOCKER}</p>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {!diff && !error && <p>Loading…</p>}
      {diff && <><p>{diff.changes.length} changed files</p>{diff.changes.map((c) => <div key={c.path} className="text-sm"><code>{c.path}</code><p>{c.before === null ? 'Added' : c.after === null ? 'Deleted' : 'Modified'}{c.after ? `, content hash ${c.after.hash}` : ''}</p></div>)}</>}
      <button className="ctl-menu" onClick={() => setOpen(false)}>Close</button>
    </ReviewDialog>}</>;
}
