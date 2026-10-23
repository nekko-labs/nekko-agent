import React, { useCallback, useEffect, useId, useState } from 'react';
import type { ClaudeCapability, ClaudeCapabilityStatus, ClaudeCodeStatus, ClaudePolicy } from '@nekko-agent/shared';
import { CLAUDE_PLAN_SHEET, CLAUDE_POLICY, claudeAccountName, claudeComparisonTable } from '@nekko-agent/shared';
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
function useClaudePolicy(): ClaudePolicy {
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

/** Which Claude Code login a new Claude Agent uses: the default one, or a named second account. */
export interface ClaudeAgentAccount {
  /** Account name (`work`), `undefined` for the default login. */
  account?: string;
  /** What the user typed, kept for the provider's label ("Claude Agent · Work"). */
  label?: string;
}

/**
 * The Claude Agent setup states: not installed, installed but signed out, and
 * ready. Sign-in happens in Claude Code (a Nekko terminal runs `claude`, where
 * the user types /login); Nekko only reads `claude auth status`. A second
 * Claude Code account gets its own folder (`~/.claude-<name>`), signed in the
 * same way; Nekko never opens it.
 */
export function ClaudeAgentSetup({ onSave, saving, initialAccount }: { onSave: (account: ClaudeAgentAccount) => void; saving: boolean; initialAccount?: string }) {
  const [another, setAnother] = useState(initialAccount !== undefined);
  const [typed, setTyped] = useState(initialAccount ?? '');
  const name = claudeAccountName(typed);
  const account = another ? name || undefined : undefined;
  // Another account with no usable name yet: nothing to check or save.
  const unnamed = another && !name;
  // Each check runs `claude auth status`, so wait for the typing to settle.
  const [checked, setChecked] = useState(account);
  useEffect(() => {
    const t = setTimeout(() => setChecked(account), 400);
    return () => clearTimeout(t);
  }, [account]);
  const { status, checking, refresh } = useClaudeCodeStatus(undefined, checked);
  const signIn = useStore((s) => s.openClaudeCodeSignIn);
  return (
    <div className="claude-setup col-span-2" aria-live="polite">
      <p className="text-[13px] font-medium">Claude Agent runs your installed Claude Code</p>
      <p className="mt-0.5 text-[12px] text-ink-faint">
        Sign-in happens in Claude Code, not in Nekko. Nekko never sees your Claude login. <ClaudeWhyLink label="What works with a Claude plan?" />
      </p>
      <div className="claude-account mt-3" role="radiogroup" aria-label="Claude Code account">
        <button type="button" role="radio" aria-checked={!another} className={`btn ${another ? 'btn-ghost' : 'btn-outline'}`} onClick={() => setAnother(false)}>
          My usual Claude Code login
        </button>
        <button type="button" role="radio" aria-checked={another} className={`btn ${another ? 'btn-outline' : 'btn-ghost'}`} onClick={() => setAnother(true)}>
          Another account
        </button>
      </div>
      {another && (
        <label className="mt-2 block text-[12px] font-medium text-ink-soft">
          Account name
          <input className="input mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Work" maxLength={40} />
          <span className="mt-1 block text-[11px] font-normal text-ink-faint">
            {name ? <>Claude Code keeps this login in <code>~/.claude-{name}</code>. It is a separate sign-in, so you can use a work and a personal account side by side.</> : 'A short name, like Work or Client A.'}
          </span>
        </label>
      )}
      {unnamed ? null : <div className="claude-setup-state mt-3" data-state={!status ? 'checking' : !status.installed ? 'missing' : status.loggedIn ? 'ready' : 'signed-out'}>
        {!status ? (
          <span className="text-[12px] text-ink-faint">Looking for Claude Code…</span>
        ) : !status.installed ? (
          <>
            <strong>Claude Code is not installed</strong>
            <span>Install it from Anthropic, then come back here.</span>
            <div className="claude-setup-actions">
              <a className="btn btn-outline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">How to install Claude Code</a>
              <button className="btn btn-ghost" onClick={refresh} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
            </div>
          </>
        ) : !status.loggedIn ? (
          <>
            <strong>Claude Code {status.version} is installed, but not signed in</strong>
            <span>Open it, type <code>/login</code>, and finish signing in with Anthropic.</span>
            <div className="claude-setup-actions">
              <button className="btn btn-primary" onClick={() => void signIn(account)}>Open Claude Code to sign in</button>
              <button className="btn btn-ghost" onClick={refresh} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
            </div>
          </>
        ) : (
          <>
            <strong>Signed in to Claude Code {status.version}</strong>
            <span>Using {claudeAuthLabel(status)}.</span>
            <div className="claude-setup-actions">
              <button className="btn btn-primary" onClick={() => onSave({ account, label: account ? typed.trim() : undefined })} disabled={saving}>{saving ? 'Adding…' : account ? `Add ${typed.trim()}` : 'Add Claude Agent'}</button>
              <button className="btn btn-ghost" onClick={refresh} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
            </div>
          </>
        )}
      </div>}
      <div className="mt-4">
        <ClaudeComparison />
      </div>
    </div>
  );
}
