import React, { useEffect, useState } from 'react';
import type { AuditEvent } from '@nekko-agent/shared';
import { Modal } from './primitives/Modal.js';
import { ShieldCheckIcon } from '../icons.js';
import { describeEvent, groupByTurn, isDecision, type AuditLine } from './auditTrailLines.js';

const TONE: Record<AuditLine['tone'], string> = {
  neutral: 'var(--ink-faint)',
  good: 'var(--success, var(--accent))',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
};

/** Defined once, so the effect below reads the trail once per chat. */
const readAudit = (id: string) => window.nekko.readAudit(id);

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * A chat's audit trail: every turn, tool call and approval, and who answered,
 * read from the engine (`audit:read`). Value-free by design: it never shows
 * what the agent read or sent.
 */
export function AuditTrail({ sessionId, incognito, onClose, load = readAudit }: {
  sessionId: string;
  incognito?: boolean;
  onClose: () => void;
  load?: (sessionId: string) => Promise<AuditEvent[]>;
}) {
  const [trail, setTrail] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDecisions, setOnlyDecisions] = useState(false);
  useEffect(() => {
    let live = true;
    load(sessionId).then((t) => { if (live) setTrail(t); }, (e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [sessionId, load]);

  const turns = groupByTurn(trail ?? [])
    .map((t) => ({ ...t, events: onlyDecisions ? t.events.filter(isDecision) : t.events }))
    .filter((t) => !onlyDecisions || t.events.length > 0)
    .reverse();
  const decisions = (trail ?? []).filter(isDecision).length;

  return (
    <Modal title="Audit trail" labelledBy="audit-trail-title" onClose={onClose} zIndex={100} overlayClassName="p-4" className="card flex max-h-[80vh] w-full max-w-2xl flex-col p-0">
      <div className="flex items-start gap-3 border-b border-line px-5 py-4" data-audit-trail>
        <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-ink-faint" />
        <div className="min-w-0 flex-1">
          <h2 id="audit-trail-title" className="font-semibold">Audit trail</h2>
          <p className="mt-1 text-xs text-ink-faint">What the agent did in this chat and who allowed it. It never holds what the agent read or sent, and it is deleted with the chat.</p>
        </div>
        <div className="flex shrink-0 rounded-lg border border-line p-0.5 text-xs" role="group" aria-label="Show">
          <button type="button" className={`rounded-md px-2 py-1 ${!onlyDecisions ? 'bg-surface-2 text-ink' : 'text-ink-faint'}`} aria-pressed={!onlyDecisions} onClick={() => setOnlyDecisions(false)}>Everything</button>
          <button type="button" className={`rounded-md px-2 py-1 ${onlyDecisions ? 'bg-surface-2 text-ink' : 'text-ink-faint'}`} aria-pressed={onlyDecisions} onClick={() => setOnlyDecisions(true)}>Approvals{decisions ? ` (${decisions})` : ''}</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {error && <p role="alert" className="text-sm text-(--danger)">Couldn't read the audit trail: {error}</p>}
        {!error && trail === null && <p className="text-sm text-ink-faint">Reading…</p>}
        {!error && trail?.length === 0 && (
          <p className="text-sm text-ink-faint" data-audit-empty>
            {incognito ? 'Incognito chats keep no audit trail.' : 'Nothing recorded yet. Turns, tool calls and approvals appear here as the agent works.'}
          </p>
        )}
        {!error && trail && trail.length > 0 && turns.length === 0 && <p className="text-sm text-ink-faint">No approvals in this chat.</p>}
        {turns.map((turn) => {
          const head = turn.start ? describeEvent(turn.start) : null;
          return (
            <section key={`${turn.turnId}-${turn.start?.at ?? turn.events[0]?.at}`} className="mb-4" data-audit-turn={turn.turnId}>
              <div className="mb-1 flex items-baseline gap-2 text-xs">
                <span className="font-semibold text-ink">{head?.text ?? 'Turn'}</span>
                {head?.detail && <span className="truncate text-ink-faint">{head.detail}</span>}
                {turn.start && <span className="ml-auto shrink-0 tabular-nums text-ink-faint">{time(turn.start.at)}</span>}
              </div>
              <ol className="space-y-1 border-l border-line pl-3">
                {turn.events.map((e, i) => {
                  const line = describeEvent(e);
                  return (
                    <li key={i} className="flex items-baseline gap-2 text-xs" data-audit-event={e.type}>
                      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE[line.tone] }} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="text-ink">{line.text}</span>
                        {line.detail && <span className="block truncate text-ink-faint" title={line.detail}>{line.detail}</span>}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink-faint">{time(e.at)}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
      <div className="flex justify-end border-t border-line px-5 py-3">
        <button className="btn btn-outline" autoFocus onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
