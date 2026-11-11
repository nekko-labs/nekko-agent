import { useRef, useState } from 'react';

import type { SecretRequest } from '@nekko-agent/shared';
import { GfLockIcon } from '../../gentleface-icons.js';

/**
 * The chat's secret box (#2594): the agent asked for an API key, token or
 * password by name, and the user pastes or types it here. The value goes
 * straight to the engine (`provideSecret`), which sets it for the chat's
 * commands; the agent only learns that it was given. Nothing here keeps the
 * value after it is sent: the field is cleared, and it never enters the
 * transcript or any store.
 */
export function SecretBox({
  request,
  onProvide,
  onSkip,
}: {
  request: SecretRequest;
  /** Resolves false when no turn waits on the request any more. */
  onProvide: (value: string) => Promise<boolean>;
  onSkip: () => Promise<boolean>;
}) {
  const [value, setValue] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const ready = value.trim().length > 0;

  const send = async (provide: boolean) => {
    if (sending.current || (provide && !ready)) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const ok = provide ? await onProvide(value) : await onSkip();
      if (provide) setValue('');
      if (!ok) setError('The agent stopped waiting for this.');
    } catch (e) {
      setError(provide ? `Could not hand it over. Try again. ${(e as Error).message ?? ''}`.trim() : (e as Error).message);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  // Paste reads the clipboard straight into the field: the value is never
  // shown, unless the user asks to see it.
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setValue(text.trim());
      field.current?.focus();
    } catch {
      field.current?.focus();
      setError('Press Ctrl+V (⌘V on a Mac) to paste.');
    }
  };

  const dollar = `$${request.name}`;
  return (
    <div
      className="secret-box"
      role="group"
      aria-label={`The agent needs ${request.name}`}
      aria-busy={busy || undefined}
      data-secret-box
      data-call-id={request.callId}
    >
      <div className="flex items-start gap-2">
        <span data-icon-hover className="mt-0.5 shrink-0 text-ink-soft"><GfLockIcon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-ink" title={request.name}>{request.name}</div>
          {request.reason && <div className="mt-1 text-xs text-ink-soft">{request.reason}</div>}
        </div>
      </div>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); void send(true); }}
      >
        <input
          ref={field}
          className="quiet-field min-w-0 flex-1 basis-56 font-mono text-sm"
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          placeholder="Paste or type it"
          aria-label={`Value for ${request.name}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
        />
        <button type="button" className="btn btn-ghost" onClick={() => void paste()} disabled={busy} data-secret-paste>Paste</button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setShown((s) => !s)}
          disabled={busy || !value}
          aria-pressed={shown}
          data-secret-show
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 basis-56 text-xs text-ink-faint">
          The agent never sees it. Its commands in this chat use <code className="font-mono">{dollar}</code>.
        </span>
        <button type="button" className="btn btn-ghost" onClick={() => void send(false)} disabled={busy} data-secret-skip>Skip</button>
        <button type="button" className="btn btn-primary" onClick={() => void send(true)} disabled={busy || !ready} data-secret-provide>
          {busy ? 'Sending…' : 'Provide'}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-(--danger-text)">{error}</p>}
    </div>
  );
}
