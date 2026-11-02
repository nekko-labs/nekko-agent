import { useId, useLayoutEffect, useRef, useState } from 'react';

import type { ToolCall } from '@nekko-agent/shared';
import { ShieldIcon } from '../../icons.js';
import type { ApprovalScope } from './approval-decision.js';

export interface PendingApproval {
  call: ToolCall;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/** True when a single-line element's content is cut off horizontally. */
export function isTruncated(el?: Pick<HTMLElement, 'scrollWidth' | 'clientWidth'> | null): boolean {
  return el ? el.scrollWidth > el.clientWidth : false;
}

/**
 * Whether the command needs a "Show full command" control: its collapsed line
 * is cut off, or it has line breaks the single line hides. Expanded text no
 * longer overflows, so the control stays while expanded to collapse it again.
 */
export function needsFullTextToggle(text: string, overflowing: boolean, expanded: boolean): boolean {
  return expanded || overflowing || /[\r\n]/.test(text);
}

/** Keyboard decisions stay scoped to this approval surface; Y approves once. */
export function ApprovalBar({ approval, onDecide, computerName }: { approval: PendingApproval; computerName?: string; onDecide: (ok: boolean, scope?: ApprovalScope) => Promise<void> }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  const deciding = useRef(false);
  const codeRef = useRef<HTMLElement>(null);
  const codeId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // ChatPane keeps this bar mounted when one approval replaces another, so a
  // new request starts collapsed instead of inheriting the last one's state.
  const [shownCallId, setShownCallId] = useState(approval.call.id);
  if (shownCallId !== approval.call.id) {
    setShownCallId(approval.call.id);
    setExpanded(false);
  }

  const commandText = String((approval.call.input as Record<string, unknown>).command ?? JSON.stringify(approval.call.input));
  const showToggle = needsFullTextToggle(commandText, overflowing, expanded);

  // Measure the collapsed line after layout and whenever it resizes: a short
  // command can still be cut off in a narrow pane, such as a wall cell.
  useLayoutEffect(() => {
    const el = codeRef.current;
    if (expanded || !el) return;
    const measure = () => setOverflowing(isTruncated(el));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, commandText]);

  // Do not steal focus from another chat; shortcuts require focus inside this prompt.
  const decide = async (ok: boolean, scope: ApprovalScope = 'once') => {
    if (deciding.current) return;
    deciding.current = true;
    setBusy(true);
    setError(null);
    try { await onDecide(ok, scope); }
    catch (e) { setError((e as Error).message); }
    finally { deciding.current = false; setBusy(false); }
  };

  const color =
    approval.severity === 'high' ? 'var(--danger)' : approval.severity === 'medium' ? 'var(--warning)' : 'var(--ink-faint)';
  const buttonClass = 'btn h-7 px-3! py-0! text-xs! disabled:opacity-50';
  return (
    <div
      className="slide-up border-t border-line px-5 py-3"
      style={{ background: 'var(--surface-2)' }}
      role="alertdialog"
      aria-label={`Approval required: ${approval.reason}`}
      aria-busy={busy}
      onKeyDown={(e) => handleApprovalKey(e, (ok) => void decide(ok))}
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <ShieldIcon className="h-5 w-5" />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">Approval required</span>
            <span className="rounded-full px-2 py-0.5 text-2xs font-medium text-white" style={{ background: color }}>{approval.severity}</span>
            <span className="text-xs text-ink-faint">{approval.reason}</span>
          </div>
          <code
            ref={codeRef}
            id={codeId}
            className={`mt-0.5 block font-mono text-xs text-ink-soft ${expanded ? 'max-h-40 overflow-y-auto whitespace-pre-wrap break-all' : 'truncate'}`}
            title={commandText}
          >
            {commandText}
          </code>
          {showToggle && (
            <button
              type="button"
              className="mt-1 rounded-sm text-2xs font-medium text-ink-faint underline decoration-dotted outline-hidden hover:text-ink-soft hover:decoration-solid focus-visible:ring-2 focus-visible:ring-(--ring)"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={codeId}
            >
              {expanded ? 'Show less' : 'Show full command'}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button ref={denyRef} disabled={busy} className={`${buttonClass} btn-outline`} onClick={() => void decide(false)} title="Deny (N or Esc)">Deny</button>
          <button disabled={busy} className={`${buttonClass} btn-primary`} onClick={() => void decide(true)} title="Approve (Y)">{computerName ? `Approve on ${computerName}` : 'Approve'}</button>
          <button disabled={busy} className={`${buttonClass} btn-outline`} onClick={() => void decide(true, 'session')} title="Allow all for the rest of this chat (YOLO). Deny rules still block.">Allow all this session</button>
          <button disabled={busy} className={`${buttonClass} btn-outline`} onClick={() => void decide(true, 'always')} title="Allow all in this chat and set Settings → Chat modes to YOLO for new chats. Deny rules still block.">Always allow all</button>
        </div>

      </div>
      {error && <p role="alert" className="mx-auto mt-2 max-w-5xl text-xs text-(--danger)">{error}</p>}
    </div>
  );
}

export function handleApprovalKey(e: Pick<React.KeyboardEvent, 'key' | 'preventDefault'>, decide: (ok: boolean) => void) {
  if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); decide(true); }
  else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); decide(false); }
}
