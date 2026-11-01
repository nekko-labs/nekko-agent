import React, { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeIdentity, ClaudeCodeStatus, ClaudeComparisonColumn, ProviderConfig, ProviderKind } from '@nekko-agent/shared';
import { CLAUDE_CODE_PROVIDER_KIND, claudeAccountCheck, claudeAccountName, claudeComparisonTable, claudePlanLabel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { windowChrome } from '../../chrome.js';
import { CheckIcon, CloudIcon, LaptopIcon, TerminalIcon, WarningIcon } from '../../icons.js';
import { TerminalPane } from '../TerminalPane.js';
import { ClaudeWhyLink, useClaudeCodeStatus, useClaudePolicy } from './ClaudeAgent.js';

/**
 * The single Claude provider: one choice, then Subscription (the user's own
 * Claude Code, signed in there) or API (Anthropic, Bedrock, Vertex, Foundry,
 * run by Nekko's own engine). The comparison table is the picker, generated
 * from the policy nekkod enforces, and a diagram shows how Nekko works with
 * the chosen one.
 */

export type ClaudeChoice = ClaudeComparisonColumn['id'];

/** Provider kinds that run Claude on an API or cloud account (Nekko's engine). */
export const CLAUDE_API_KINDS: ProviderKind[] = ['anthropic', 'bedrock', 'vertex', 'foundry'];
/** Every kind the Claude choice covers. */
export const CLAUDE_KINDS: ProviderKind[] = [...CLAUDE_API_KINDS, CLAUDE_CODE_PROVIDER_KIND];
export const isClaudeKind = (k: ProviderKind) => CLAUDE_KINDS.includes(k);

/** Anthropic's official installer for the platform the terminal runs on. */
export function claudeInstallCommand(platform: string): string {
  return /^win/i.test(platform) ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
}

/**
 * Claude Code's own sign-in for a Claude plan: it opens Anthropic's page in
 * the browser, so the user never has to find `/login` inside Claude Code.
 */
export const CLAUDE_SIGNIN_COMMAND = 'claude auth login --claudeai';

const hostPlatform = () => windowChrome?.platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);

/** The Claude Code folder an account's login lives in. */
export function claudeAccountFolder(account?: string): string {
  return account ? `~/.claude-${account}` : '~/.claude';
}

/** Who a signed-in Claude Code is, in a few words: "me@example.com · Max plan". */
export function claudeIdentityLine(status: ClaudeCodeStatus | null | undefined): string {
  if (!status?.installed || !status.loggedIn) return '';
  return [status.email, claudePlanLabel(status.subscriptionType)].filter(Boolean).join(' · ');
}

/**
 * Where a Claude provider's models come from, for its card: "Subscription ·
 * Claude Code 2.1.263 · ~/.claude-work · me@example.com · Team plan", or
 * "API · Amazon Bedrock · us-east-1".
 */
export function claudeSourceLine(provider: ProviderConfig, status?: ClaudeCodeStatus | null): string {
  if (provider.kind === CLAUDE_CODE_PROVIDER_KIND) {
    const account = provider.claudeCode?.account;
    return [
      'Subscription',
      status?.installed ? `Claude Code ${status.version}` : 'through Claude Code',
      account ? claudeAccountFolder(account) : `${claudeAccountFolder()} (your usual login)`,
      claudeIdentityLine(status),
    ].filter(Boolean).join(' · ');
  }
  if (provider.kind === 'bedrock') {
    const region = /bedrock-mantle\.([a-z0-9-]+)\./.exec(provider.baseUrl)?.[1];
    return ['API', 'Amazon Bedrock', region].filter(Boolean).join(' · ');
  }
  if (provider.kind === 'vertex') return 'API · Google Vertex AI';
  if (provider.kind === 'foundry') return 'API · Microsoft Foundry';
  // A plan card from an older build, retired by the startup migration.
  if (provider.auth === 'subscription') return 'Old Claude plan sign-in, turned off';
  return 'API · Anthropic API key';
}

/** Claude Code's status for each saved subscription account, read once per provider. */
export function useClaudeCodeStatuses(providers: ProviderConfig[]): Record<string, ClaudeCodeStatus> {
  const [byId, setById] = useState<Record<string, ClaudeCodeStatus>>({});
  const ids = providers.filter((p) => p.kind === CLAUDE_CODE_PROVIDER_KIND).map((p) => p.id).join('|');
  useEffect(() => {
    if (!ids) return;
    let live = true;
    void Promise.all(ids.split('|').map((id) => window.nekko.getClaudeCodeStatus(id).then((s) => [id, s] as const).catch(() => null))).then((entries) => {
      if (live) setById(Object.fromEntries(entries.filter((e): e is readonly [string, ClaudeCodeStatus] => !!e)));
    });
    return () => { live = false; };
  }, [ids]);
  return byId;
}

/** A Claude Code terminal shown inline: the installer, or Claude Code's sign-in. */
interface InlineTerminal { id: string; purpose: 'install' | 'signin'; account?: string }

function useInlineTerminal(onTick: () => void) {
  const [term, setTerm] = useState<InlineTerminal | null>(null);
  const pushToast = useStore((s) => s.pushToast);
  const workspaceId = useStore((s) => s.activeProjectId) ?? undefined;
  // While the terminal works, re-read Claude Code's status so the panel moves on by itself.
  const tick = useRef(onTick);
  tick.current = onTick;
  useEffect(() => {
    if (!term) return;
    const t = setInterval(() => tick.current(), 3000);
    return () => clearInterval(t);
  }, [term]);
  const open = async (purpose: InlineTerminal['purpose'], account?: string) => {
    try {
      const t = await window.nekko.createTerminal({
        workspaceId,
        title: purpose === 'install' ? 'Install Claude Code' : account ? `Claude Code sign-in (${account})` : 'Claude Code sign-in',
        ...(account ? { claudeAccount: account } : {}),
      });
      setTerm({ id: t.id, purpose, account });
      await window.nekko.runInTerminal(t.id, purpose === 'install' ? claudeInstallCommand(hostPlatform()) : CLAUDE_SIGNIN_COMMAND);
    } catch (e) {
      pushToast('error', `Could not open a terminal: ${String(e)}`);
    }
  };
  /** Start the sign-in again in the open terminal, after a cancelled or expired one. */
  const retry = () => {
    if (term) void window.nekko.runInTerminal(term.id, CLAUDE_SIGNIN_COMMAND).catch((e) => pushToast('error', String(e)));
  };
  return { term, open, retry, close: () => setTerm(null) };
}

/** What the user sees once a Claude account is connected. */
export interface ClaudeConnected { title: string; detail: string }

/**
 * The Claude setup panel. `onChoice` keeps the add form's kind in step with
 * the chosen column; API connects through the form's own fields
 * (`onConnectApi`), Subscription saves a Claude Code provider here.
 */
export function ClaudeSetup({
  initialChoice,
  apiOpen,
  connected,
  onChoice,
  onConnectApi,
  onConnected,
  onDone,
}: {
  initialChoice?: ClaudeChoice;
  apiOpen: boolean;
  connected: ClaudeConnected | null;
  onChoice: (choice: ClaudeChoice) => void;
  onConnectApi: () => void;
  onConnected: (c: ClaudeConnected) => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<ClaudeChoice | undefined>(initialChoice);
  const choose = (c: ClaudeChoice) => {
    setChoice(c);
    onChoice(c);
  };
  const providers = useStore((s) => s.providers);
  const refreshProviders = useStore((s) => s.refreshProviders);
  const newChat = useStore((s) => s.newChat);
  const setView = useStore((s) => s.setView);
  const pushToast = useStore((s) => s.pushToast);
  const table = claudeComparisonTable(useClaudePolicy());

  const subs = providers.filter((p) => p.kind === CLAUDE_CODE_PROVIDER_KIND);
  const statuses = useClaudeCodeStatuses(subs);
  const { status, checking, refresh } = useClaudeCodeStatus();
  const usual = subs.find((p) => !p.claudeCode?.account);

  // "Another subscription account": a named Claude Code folder, signed in on its own.
  const [another, setAnother] = useState<string | null>(null);
  const name = claudeAccountName(another ?? '');
  const [checkedName, setCheckedName] = useState(name);
  useEffect(() => {
    const t = setTimeout(() => setCheckedName(name), 400);
    return () => clearTimeout(t);
  }, [name]);
  const other = useClaudeCodeStatus(undefined, another !== null && checkedName ? checkedName : undefined);
  const [attested, setAttested] = useState(false);

  const terminal = useInlineTerminal(() => {
    refresh();
    if (another !== null) other.refresh();
  });
  // Close the terminal once it did its job: Claude Code installed, or the login signed in.
  const watched = terminal.term?.account ? other.status : status;
  useEffect(() => {
    if (!terminal.term || !watched?.installed) return;
    if (terminal.term.purpose === 'install' || watched.loggedIn) terminal.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched]);

  const identities: (ClaudeCodeIdentity & { label: string })[] = subs.flatMap((p) => {
    const s = statuses[p.id];
    return s?.installed && s.loggedIn ? [{ label: p.label, ...s }] : [];
  });

  const [saving, setSaving] = useState(false);
  const save = async (account?: string, label?: string) => {
    setSaving(true);
    try {
      const s = account ? other.status : status;
      const base = 'Claude subscription';
      await window.nekko.saveProvider({
        id: `claude-code-${Date.now().toString(36)}`,
        kind: CLAUDE_CODE_PROVIDER_KIND,
        label: account ? `${base} · ${label || account}` : base,
        baseUrl: '',
        enabled: true,
        ...(account ? { claudeCode: { account } } : {}),
      });
      await refreshProviders();
      setAnother(null);
      setAttested(false);
      const who = claudeIdentityLine(s);
      onConnected({
        title: 'Claude is connected',
        detail: `Using your Claude subscription through Claude Code${s?.installed ? ` ${s.version}` : ''}${who ? `, signed in as ${who}` : ''}.`,
      });
    } catch (e) {
      pushToast('error', `Could not save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const usualCheck = status?.installed && status.loggedIn ? claudeAccountCheck(status, identities) : null;
  const subscriptionButton = (() => {
    if (usual) {
      return <button type="button" className="btn btn-outline claude-connect-done" disabled><CheckIcon className="h-4 w-4" />Connected</button>;
    }
    if (!status) return <button type="button" className="btn btn-primary" disabled>Checking…</button>;
    if (!status.installed) {
      return (
        <button type="button" className="btn btn-primary" onClick={() => void terminal.open('install')} disabled={terminal.term?.purpose === 'install'}>
          <TerminalIcon className="h-4 w-4" />{terminal.term?.purpose === 'install' ? 'Installing…' : 'Install Claude Code'}
        </button>
      );
    }
    if (!status.loggedIn) {
      const signingIn = terminal.term?.purpose === 'signin' && !terminal.term.account;
      return <button type="button" className="btn btn-primary" onClick={() => void terminal.open('signin')} disabled={signingIn}>{signingIn ? 'Signing in…' : 'Connect: sign in to Claude Code'}</button>;
    }
    if (usualCheck?.verdict === 'blocked') return <button type="button" className="btn btn-primary" disabled>Already connected</button>;
    return <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? 'Connecting…' : 'Connect'}</button>;
  })();

  return (
    <div className="claude-setup col-span-2" aria-live="polite">
      {connected && (
        <div className="claude-connected" role="status">
          <CheckIcon className="h-6 w-6" />
          <div className="min-w-0 flex-1">
            <strong>{connected.title}</strong>
            <span>{connected.detail}</span>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => { setView('command'); void newChat(); }}>Start a chat</button>
          <button type="button" className="btn btn-ghost" onClick={onDone}>Done</button>
        </div>
      )}

      <ClaudeDetect status={status} checking={checking} installing={terminal.term?.purpose === 'install'} onRetry={refresh} />

      <ClaudeChoiceTable
        table={table}
        choice={choice}
        onChoose={choose}
        subscriptionNote={claudeCodeNote(status, !!usual)}
        footer={{
          subscription: subscriptionButton,
          api: apiOpen ? null : <button type="button" className="btn btn-primary" onClick={onConnectApi}>Connect: add a key or cloud account</button>,
        }}
      />

      {choice === 'subscription' && usualCheck?.verdict === 'blocked' && !usual && (
        <p className="claude-verdict" data-verdict="blocked" role="alert">{usualCheck.message}</p>
      )}

      {terminal.term && (
        <div className="claude-terminal">
          <div className="claude-terminal-bar">
            <TerminalIcon className="h-4 w-4" />
            <span className="min-w-0 flex-1">
              {terminal.term.purpose === 'install'
                ? 'Installing Claude Code with Anthropic’s installer. This closes by itself when it finishes.'
                : 'Claude Code is signing you in. Nekko never sees your login.'}
            </span>
            {terminal.term.purpose === 'signin' && (
              <button type="button" className="btn btn-ghost py-1 text-xs" onClick={terminal.retry}>Start sign-in again</button>
            )}
            <button type="button" className="btn btn-ghost py-1 text-xs" onClick={terminal.close}>Hide</button>
          </div>
          {terminal.term.purpose === 'signin' && (
            <ol className="claude-signin-steps">
              <li><b>Finish in your browser.</b> Claude Code opened Anthropic’s sign-in page. Sign in with the Claude account that has your plan and approve.</li>
              <li><b>No page opened?</b> Open the link Claude Code shows below. If the page gives you a code, paste it into the terminal and press Enter.</li>
              <li><b>That’s it.</b> This panel moves on by itself once Claude Code is signed in.</li>
            </ol>
          )}
          <div className="claude-terminal-body"><TerminalPane terminalId={terminal.term.id} /></div>
        </div>
      )}

      {choice === 'subscription' && usual && another === null && (
        <button type="button" className="claude-link" onClick={() => setAnother('')}>+ Another subscription account</button>
      )}
      {choice === 'subscription' && another !== null && (
        <AnotherAccount
          typed={another}
          onType={setAnother}
          name={name}
          status={checkedName === name ? other.status : null}
          check={other.status?.installed && other.status.loggedIn && checkedName === name ? claudeAccountCheck(other.status, identities) : null}
          attested={attested}
          onAttest={setAttested}
          saving={saving}
          onSignIn={() => void terminal.open('signin', name)}
          onSave={() => void save(name, another.trim())}
          onCancel={() => { setAnother(null); setAttested(false); }}
        />
      )}

      {choice && <ClaudeHowItWorks choice={choice} />}
      <p className="mt-3 text-xs text-ink-faint"><ClaudeWhyLink label="What works with a Claude plan?" /></p>
    </div>
  );
}

/** The line under the Subscription header: what was found on this computer. */
function claudeCodeNote(status: ClaudeCodeStatus | null, connected: boolean): { tone: 'busy' | 'ok' | 'off'; text: string } {
  if (connected) return { tone: 'ok', text: 'Connected' };
  if (!status) return { tone: 'busy', text: 'Checking for Claude Code' };
  if (!status.installed) return { tone: 'off', text: 'Claude Code not installed' };
  return { tone: 'ok', text: `Claude Code ${status.version} found` };
}

/** "Checking if Claude Code is already installed…" and what the check found. */
function ClaudeDetect({ status, checking, installing, onRetry }: { status: ClaudeCodeStatus | null; checking: boolean; installing: boolean; onRetry: () => void }) {
  if (installing) return <div className="claude-detect"><span className="claude-spin" />Installing Claude Code in a Nekko terminal…</div>;
  if (!status) return <div className="claude-detect"><span className="claude-spin" />Checking if Claude Code is already installed…</div>;
  if (!status.installed) {
    return (
      <div className="claude-detect" data-tone="off">
        <BanIcon />
        <span className="min-w-0 flex-1">Claude Code isn't installed on this computer. You need it to use your subscription.</span>
        <button type="button" className="btn btn-ghost py-1 text-xs" onClick={onRetry} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
      </div>
    );
  }
  const who = claudeIdentityLine(status);
  return (
    <div className="claude-detect" data-tone="ok">
      <CheckIcon className="h-4 w-4" />
      <span className="min-w-0 flex-1">
        Found Claude Code <code>{status.version}</code>.{' '}
        {status.loggedIn ? (who ? `Signed in as ${who}.` : 'Signed in.') : "It isn't signed in yet."}
      </span>
    </div>
  );
}

/** The comparison table as the picker: click a column to choose it. */
function ClaudeChoiceTable({
  table,
  choice,
  onChoose,
  subscriptionNote,
  footer,
}: {
  table: ReturnType<typeof claudeComparisonTable>;
  choice: ClaudeChoice | undefined;
  onChoose: (c: ClaudeChoice) => void;
  subscriptionNote: { tone: 'busy' | 'ok' | 'off'; text: string };
  footer: Record<ClaudeChoice, React.ReactNode>;
}) {
  const col = (id: ClaudeChoice) => ({
    className: 'claude-col',
    'data-col': id,
    'data-on': choice === id || undefined,
    onClick: () => onChoose(id),
  });
  return (
    <div className="claude-choice" role="radiogroup" aria-label="How to use Claude">
      <table>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Feature</span></th>
            {table.columns.map((c) => (
              <th key={c.id} scope="col" {...col(c.id)}>
                <button type="button" role="radio" aria-checked={choice === c.id} className="claude-col-head" onClick={(e) => { e.stopPropagation(); onChoose(c.id); }}>
                  <span className="claude-radio" aria-hidden="true" />
                  <span>{c.label}</span>
                </button>
                <small>{c.detail}</small>
                {c.id === 'subscription' && (
                  <span className="claude-col-note" data-tone={subscriptionNote.tone}>
                    {subscriptionNote.tone === 'busy' ? <span className="claude-spin" /> : subscriptionNote.tone === 'ok' ? <CheckIcon className="h-3.5 w-3.5" /> : <BanIcon />}
                    {subscriptionNote.text}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.capability}>
              <th scope="row">{r.label}</th>
              {r.cells.map((cell, i) => {
                const yes = cell === 'Yes';
                return (
                  <td key={table.columns[i].id} {...col(table.columns[i].id)} data-yes={yes || undefined}>
                    <span className="claude-cell">
                      {yes ? <CheckIcon className="h-4 w-4" /> : <BanIcon />}
                      {cell}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <th scope="row">Billed to</th>
            {table.billedTo.map((b, i) => <td key={table.columns[i].id} {...col(table.columns[i].id)}>{b}</td>)}
          </tr>
          <tr>
            <th scope="row">Needs</th>
            {table.needs.map((n, i) => <td key={table.columns[i].id} {...col(table.columns[i].id)}>{n}</td>)}
          </tr>
        </tbody>
        {choice && (
          <tfoot>
            <tr>
              <td />
              {table.columns.map((c) => <td key={c.id}>{choice === c.id ? footer[c.id] : null}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** A circle with a slash: a feature that is off. */
function BanIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="h-4 w-4">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M3.7 12.3 12.3 3.7" />
    </svg>
  );
}

/** Claude's spark, drawn here: marks the parts that are Claude itself. */
function SparkIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className={className}>
      <path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.3 5.3l4.2 4.2M14.5 14.5l4.2 4.2M18.7 5.3l-4.2 4.2M9.5 14.5l-4.2 4.2" />
    </svg>
  );
}

const FEATURES: { label: string; subscription: boolean }[] = [
  { label: 'Chat & approvals', subscription: true },
  { label: 'Phone remote', subscription: true },
  { label: 'Scheduled tasks', subscription: false },
  { label: 'Nekko tools', subscription: false },
  { label: 'Usage limits', subscription: false },
  { label: 'Model routing', subscription: false },
];

/** "How Nekko works with Claude": what runs on this computer and what is in the cloud. */
export function ClaudeHowItWorks({ choice }: { choice: ClaudeChoice }) {
  const sub = choice === 'subscription';
  return (
    <section className="claude-how" aria-label="How Nekko works with Claude">
      <h4>How Nekko works with Claude</h4>
      <div className="claude-diagram">
        <div className="claude-zone" data-zone="machine">
          <span className="claude-zone-label"><LaptopIcon className="h-3.5 w-3.5" />Your computer</span>
          <div className="claude-nekko">
            <strong>Nekko Agent</strong>
            <div className="claude-feats">
              {FEATURES.map((f) => {
                const on = !sub || f.subscription;
                return (
                  <span key={f.label} className="claude-feat" data-on={on || undefined}>
                    {on ? <CheckIcon className="h-3.5 w-3.5" /> : <BanIcon />}
                    {f.label}
                  </span>
                );
              })}
            </div>
            {sub ? (
              <div className="claude-engine" data-engine="external"><TerminalIcon className="h-4 w-4" /><span><b>Hands the turn to Claude Code</b><small>Nekko shows the work and your approvals</small></span></div>
            ) : (
              <div className="claude-engine" data-engine="built-in"><SparkIcon /><span><b>Claude, built in</b><small>Nekko runs every turn itself</small></span></div>
            )}
          </div>
          {sub && (
            <>
              <span className="claude-wire"><span aria-hidden="true">→</span>runs</span>
              <div className="claude-svc" data-svc="claude-code"><TerminalIcon className="h-5 w-5" /><span><b>Claude Code</b><small>signed in by you</small></span></div>
            </>
          )}
        </div>
        <span className="claude-wire"><span aria-hidden="true">→</span>API call</span>
        <div className="claude-zone" data-zone="cloud">
          <span className="claude-zone-label"><CloudIcon className="h-3.5 w-3.5" />Cloud</span>
          <div className="claude-svc" data-svc="api"><SparkIcon className="h-5 w-5" /><span><b>Claude API</b><small>{sub ? 'on your Claude plan' : 'Anthropic, Bedrock, Vertex or Foundry'}</small></span></div>
        </div>
      </div>
      <p className="claude-how-note">
        {sub
          ? 'Claude Code runs on your computer, outside Nekko, and calls Claude on your plan. Nekko never sees your Claude login, so the features that need Nekko to run the turn are off.'
          : 'Everything happens inside Nekko on your computer. It only reaches out to the Claude API for each answer, using your key or cloud account, so every feature is on.'}
      </p>
    </section>
  );
}

/**
 * Adding another subscription account: a name, its own Claude Code folder,
 * sign-in there, then the check against the accounts already connected
 * (`claudeAccountCheck`): the same login is refused, a second personal plan
 * needs the user to confirm it is for separate work.
 */
function AnotherAccount({
  typed,
  onType,
  name,
  status,
  check,
  attested,
  onAttest,
  saving,
  onSignIn,
  onSave,
  onCancel,
}: {
  typed: string;
  onType: (v: string) => void;
  name: string;
  status: ClaudeCodeStatus | null;
  check: ReturnType<typeof claudeAccountCheck> | null;
  attested: boolean;
  onAttest: (v: boolean) => void;
  saving: boolean;
  onSignIn: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const label = typed.trim();
  return (
    <div className="claude-another">
      <label className="block text-xs font-medium text-ink-soft">
        Name for the other account
        <input className="input mt-1" value={typed} onChange={(e) => onType(e.target.value)} placeholder="Work" maxLength={40} autoFocus />
        <span className="mt-1 block text-2xs font-normal text-ink-faint">
          {name ? <>Claude Code keeps this login in its own folder, <code>{claudeAccountFolder(name)}</code>.</> : 'A short name, like Work or Client A.'}
        </span>
      </label>
      {name && !status && <p className="claude-detect mt-2"><span className="claude-spin" />Checking that folder's sign-in…</p>}
      {name && status?.installed && !status.loggedIn && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-soft">Not signed in yet.</span>
          <button type="button" className="btn btn-primary" onClick={onSignIn}>Sign in to {label || name}</button>
        </div>
      )}
      {check && (
        <div className="claude-verdict" data-verdict={check.verdict} role={check.verdict === 'blocked' ? 'alert' : undefined}>
          <p className="claude-verdict-head">
            {check.verdict === 'ok' ? <CheckIcon className="h-4 w-4" /> : check.verdict === 'confirm' ? <WarningIcon className="h-4 w-4" /> : <BanIcon />}
            {check.verdict === 'ok' ? 'A different person or organization' : check.verdict === 'confirm' ? 'Another personal plan' : 'The same login again'}
          </p>
          <p>{check.verdict !== 'blocked' && claudeIdentityLine(status) ? `Signed in as ${claudeIdentityLine(status)}. ` : ''}{check.message}</p>
          {check.verdict === 'confirm' && (
            <label className="claude-attest">
              <input type="checkbox" checked={attested} onChange={(e) => onAttest(e.target.checked)} />
              This account is for separate work, not for adding up my limits.
            </label>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {check.verdict === 'blocked' ? (
              <>
                <button type="button" className="btn btn-primary" disabled>Can't add this account</button>
                <button type="button" className="btn btn-outline" onClick={onSignIn}>Sign in with a different account</button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving || (check.verdict === 'confirm' && !attested)}>
                {saving ? 'Adding…' : `Add ${label || name}`}
              </button>
            )}
            <a className="claude-link" href="https://nekkoagent.com/docs/accounts" target="_blank" rel="noreferrer">What Anthropic allows</a>
          </div>
        </div>
      )}
      <button type="button" className="claude-link mt-2" onClick={onCancel}>Cancel</button>
    </div>
  );
}
