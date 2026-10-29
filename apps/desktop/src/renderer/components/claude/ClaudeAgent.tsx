import React, { useCallback, useEffect, useId, useState } from 'react';
import type { ClaudeCapability, ClaudeCapabilityStatus, ClaudeCodeStatus, ClaudePolicy } from '@nekko-agent/shared';
import { CLAUDE_PLAN_SHEET, CLAUDE_POLICY, claudeComparisonTable } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { CloseIcon } from '../../icons.js';
import { Modal } from '../primitives/index.js';

/**
 * Claude Agent: the user's own installed Claude Code runs the chat and the
 * user signs in inside Claude Code, never in Nekko. Everything here reads
 * nekkod's `claude:*` routes, so what the UI says is what the daemon enforces.
 */

/** How the user's Claude Code is set up, re-read whenever the window regains focus. */
export function useClaudeCodeStatus(providerId?: string, account?: string): { status: ClaudeCodeStatus | null; checking: boolean; refresh: () => void } {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(() => {
    setChecking(true);
    window.nekko
      .getClaudeCodeStatus(providerId, account)
      .then(setStatus)
      .catch((e) => setStatus({ installed: false, message: String(e) }))
      .finally(() => setChecking(false));
  }, [providerId, account]);
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  return { status, checking, refresh };
}

/** One provider's row for a Claude capability; `null` until read or when there is no provider. */
export function useClaudeCapability(providerId: string | undefined, capability: ClaudeCapability): ClaudeCapabilityStatus | null {
  const [row, setRow] = useState<ClaudeCapabilityStatus | null>(null);
  useEffect(() => {
    if (!providerId) {
      setRow(null);
      return;
    }
    let live = true;
    window.nekko
      .getClaudeCapability(providerId, capability)
      .then((r) => live && setRow(r))
      .catch(() => live && setRow(null));
    return () => {
      live = false;
    };
  }, [providerId, capability]);
  return row;
}

/** The policy nekkod enforces (shipped table plus any signed override). */
export function useClaudePolicy(): ClaudePolicy {
  const [policy, setPolicy] = useState<ClaudePolicy>(CLAUDE_POLICY);
  useEffect(() => {
    window.nekko
      .getClaudePolicy()
      .then((s) => setPolicy(s.policy))
      .catch(() => {});
  }, []);
  return policy;
}

/** "Why?": opens the "What works with a Claude plan?" sheet. */
export function ClaudeWhyLink({ label = 'Why?' }: { label?: string }) {
  const open = useStore((s) => s.setClaudePlanSheet);
  return (
    <button type="button" className="claude-why" onClick={() => open(true)}>
      {label}
    </button>
  );
}

/** A greyed control's reason line, with the "Why?" link. */
export function ClaudeReasonLine({ message }: { message: string }) {
  return (
    <p className="claude-reason" role="note">
      {message} <ClaudeWhyLink />
    </p>
  );
}

/** What each Claude path can do, generated from the policy table. */
export function ClaudeComparison() {
  const table = claudeComparisonTable(useClaudePolicy());
  return (
    <div className="claude-compare" role="region" aria-label="What each Claude option can do">
      <table>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Feature</span></th>
            {table.columns.map((c) => (
              <th key={c.id} scope="col">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.capability}>
              <th scope="row">{r.label}</th>
              {r.cells.map((cell, i) => (
                <td key={table.columns[i].id} data-yes={cell === 'Yes' || undefined}>{cell}</td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">Billed to</th>
            {table.billedTo.map((b, i) => (
              <td key={table.columns[i].id}>{b}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** "Using your Claude plan in Nekko Agent": mounted once at the app root. */
export function ClaudePlanSheet() {
  const open = useStore((s) => s.claudePlanSheet);
  const setOpen = useStore((s) => s.setClaudePlanSheet);
  const titleId = useId();
  if (!open) return null;
  const close = () => setOpen(false);
  return (
    <Modal title={CLAUDE_PLAN_SHEET.title} labelledBy={titleId} onClose={close} overlayClassName="p-4" className="card claude-sheet w-full max-w-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-[16px] font-semibold">{CLAUDE_PLAN_SHEET.title}</h2>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" onClick={close} aria-label="Close">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
      {CLAUDE_PLAN_SHEET.paragraphs.map((p) => (
        <p key={p} className="mt-3 text-[13px] leading-relaxed text-ink-soft">{p}</p>
      ))}
      <div className="mt-4">
        <ClaudeComparison />
      </div>
    </Modal>
  );
}

/** The Claude Code sign-in method, in plain words. */
export function claudeAuthLabel(status: ClaudeCodeStatus): string {
  if (!status.installed || !status.loggedIn) return '';
  if (status.auth === 'cloud') return `a cloud account (${status.apiProvider ?? status.authMethod})`;
  if (status.auth === 'api_key') return 'an Anthropic API key';
  if (status.auth === 'subscription') return 'your Claude plan';
  return status.authMethod;
}
