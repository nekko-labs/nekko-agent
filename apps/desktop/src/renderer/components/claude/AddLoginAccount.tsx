import React, { useEffect, useState } from 'react';
import type { ClaudeCodeIdentity, ProviderConfig } from '@nekko-agent/shared';
import { CLAUDE_CODE_PROVIDER_KIND, claudeAccountCheck } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { TerminalPane } from '../TerminalPane.js';
import { TerminalIcon } from '../../icons.js';
import { useClaudeCodeStatus } from './ClaudeAgent.js';
import { useInlineTerminal } from './ClaudeSetup.js';
import { claudeProfileConflict } from './claudeProfiles.js';
import { accountIdentity, identityLine } from '../../providerAccounts.js';

/**
 * The Claude Code folder for another account on a login: `account-2`,
 * `account-3`..., the first no saved provider uses. The user never names it:
 * the account names itself from its sign-in ("Nekko Labs · Team").
 */
export function nextAccountFolder(providers: ProviderConfig[]): string {
  for (let n = 2; ; n++) {
    const name = `account-${n}`;
    if (!claudeProfileConflict(providers, name)) return name;
  }
}

/** The saved Claude subscription accounts as `claudeAccountCheck` compares them. */
function savedIdentities(providers: ProviderConfig[]): (ClaudeCodeIdentity & { label: string })[] {
  return providers.flatMap((p) => {
    const a = p.kind === CLAUDE_CODE_PROVIDER_KIND ? p.account : undefined;
    if (!a?.signedIn || !a.email) return [];
    return [{ label: identityLine(accountIdentity(p)) || p.label, email: a.email, orgId: a.orgId ?? null, subscriptionType: a.plan ?? null }];
  });
}

/**
 * "Add another account on this login", under a login on the Models page. One
 * email can have a personal plan and an organization seat; Claude Code signs
 * in to one of them per folder, so the other one is a second sign-in in its
 * own folder, picking the other account when Anthropic asks which to use.
 * Nekko never sees the login: it reads only `claude auth status`, then the
 * same check as setup (the same account twice is refused).
 */
export function AddLoginAccount({ email }: { email: string }) {
  const providers = useStore((s) => s.providers);
  const refreshProviders = useStore((s) => s.refreshProviders);
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const { status, refresh } = useClaudeCodeStatus(undefined, open && folder ? folder : undefined);
  const terminal = useInlineTerminal(refresh);
  const [attested, setAttested] = useState(false);
  const [saving, setSaving] = useState(false);

  const signedIn = !!status?.installed && status.loggedIn;
  // The sign-in finished: the terminal has done its job.
  useEffect(() => { if (signedIn && terminal.term) terminal.close(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [signedIn]);

  const start = () => {
    const name = nextAccountFolder(providers);
    setFolder(name);
    setOpen(true);
    setAttested(false);
    void terminal.open('signin', name);
  };
  const cancel = () => { terminal.close(); setOpen(false); setFolder(''); };

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost ml-5 mt-1 px-3 text-xs" onClick={start} data-add-login-account={email}
        title={`Sign in again as ${email} and pick the other account (a personal plan or an organization) when Anthropic asks`}>
        + Add another account on this login
      </button>
    );
  }

  const candidate = signedIn ? accountIdentity({ id: '', kind: CLAUDE_CODE_PROVIDER_KIND, label: '', baseUrl: '', enabled: true }, { claude: status }) : null;
  const check = signedIn && status.auth === 'subscription' ? claudeAccountCheck(status, savedIdentities(providers)) : null;
  const otherLogin = signedIn && status.email && status.email.toLowerCase() !== email.toLowerCase();
  const save = async () => {
    if (!candidate || claudeProfileConflict(useStore.getState().providers, folder)) return;
    setSaving(true);
    try {
      await window.nekko.saveProvider({
        id: `claude-code-${Date.now().toString(36)}`,
        kind: CLAUDE_CODE_PROVIDER_KIND,
        label: `Claude subscription · ${candidate.name}`,
        baseUrl: '',
        enabled: true,
        claudeCode: { account: folder },
      });
      await refreshProviders();
      pushToast('success', `${identityLine(candidate)} added.`);
      cancel();
    } catch (e) {
      pushToast('error', `Could not save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ml-5 mt-2 flex min-w-0 flex-col gap-2 pr-3" data-add-login-flow={email} aria-live="polite">
      {!signedIn && (
        <p className="text-xs text-ink-soft">
          Sign in as <b className="font-medium text-ink">{email}</b> and pick the other account when Anthropic asks which one to use.
        </p>
      )}
      {terminal.term && (
        <div className="claude-terminal">
          <div className="claude-terminal-bar">
            <TerminalIcon className="h-4 w-4" />
            <span className="min-w-0 flex-1">Claude Code is signing you in. Nekko never sees your login.</span>
            <button type="button" className="btn btn-ghost py-1 text-xs" onClick={terminal.retry}>Start sign-in again</button>
          </div>
          <div className="claude-terminal-body"><TerminalPane terminalId={terminal.term.id} /></div>
        </div>
      )}
      {signedIn && candidate && check && (
        <div className="flex min-w-0 flex-col gap-2" data-add-login-verdict={check.verdict}>
          <p className="text-xs text-ink-soft">
            {check.verdict === 'blocked'
              ? <>That is {check.sameAs}, already connected. Sign in again and pick the other account.</>
              : <>Signed in as <b className="font-medium text-ink">{identityLine(candidate)}</b>{otherLogin ? <> ({status.email}, a different login, so it shows as its own connection)</> : null}.</>}
          </p>
          {check.verdict === 'confirm' && (
            <label className="flex items-start gap-2 text-xs text-ink-soft">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
              <span>Another personal plan: this account is for separate work, not for adding up my limits.</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {check.verdict === 'blocked'
              ? <button type="button" className="btn btn-primary text-xs" onClick={() => void terminal.open('signin', folder)}>Sign in again</button>
              : <button type="button" className="btn btn-primary text-xs" disabled={saving || (check.verdict === 'confirm' && !attested)} onClick={() => void save()}>{saving ? 'Adding…' : `Add ${candidate.name}`}</button>}
            <button type="button" className="btn btn-ghost text-xs" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {signedIn && !check && <p className="text-xs text-ink-soft">That folder signed in with an API key, not a Claude plan. Sign in again with your Claude account.</p>}
      {!signedIn && <div><button type="button" className="btn btn-ghost text-xs" onClick={cancel}>Cancel</button></div>}
    </div>
  );
}
