import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_RUNNER_LABEL,
  IDLE_GITHUB_SETUP,
  MAX_RUNNER_REPOS,
  PRIORITY_DESCRIPTIONS,
  PRIORITY_LABELS,
  defaultRepoPicks,
  githubAppSettingsUrl,
  githubInstallUrl,
  publicPicks,
  servesOneRepo,
  tickRepo,
  toConnectRequest,
  toSetupRequest,
  type ConnectForm,
  type ConnectRequest,
  type ForkApproval,
  type GithubAccounts,
  type GithubSetupView,
  type Priority,
  type RunnerSettings,
  type RunnerView,
  type SetupPicks,
} from '@nekko-agent/shared';
import { Modal } from './primitives/index.js';
import { CheckIcon, ExternalIcon } from '../icons.js';
import { useStore } from '../store.js';

export type ConnectStep = 1 | 2 | 3;
const CREATE_APP_DOCS = 'https://nekkoagent.com/docs/ci-runners#create-the-github-app';
const STEPS = ['Install app', 'Org or repo', 'How this Mac helps'];
const PRIORITIES: Priority[] = ['doNotDisturb', 'balanced', 'runnerFirst'];

export const emptyConnectForm = (): ConnectForm => ({
  appId: '', installationId: '', privateKeyPem: '', kind: 'repo', target: '', repos: '', allowPublic: false, label: '', priority: 'doNotDisturb',
});

export interface ConnectDeps {
  connectRunner(req: ConnectRequest): Promise<RunnerView>;
  updateRunner(id: string, settings: Partial<RunnerSettings>): Promise<RunnerView>;
  pushToast(kind: 'error' | 'success' | 'info', message: string): void;
}

/**
 * The first error in the fields up to `through`, or null. Step 1's own check
 * fills step 2 with known-good values, so it never reports a step 2 field.
 */
export function stepError(form: ConnectForm, through: 1 | 2, keyStored = false): string | null {
  const f = through === 1 ? { ...form, kind: 'repo' as const, target: 'a/b', label: '' } : form;
  const req = toConnectRequest(f, keyStored);
  return 'error' in req ? req.error : null;
}

/**
 * Start runner: validate, connect, then apply the chosen mode. Errors come back
 * as the sentence to show and the step that owns it; the key is never in them.
 * Once connect resolves the runner exists, so a failed mode update only toasts.
 */
export async function submitConnect(
  form: ConnectForm,
  deps: ConnectDeps,
  keyStored = false,
): Promise<{ error: string; step: ConnectStep } | { view: RunnerView; form: ConnectForm }> {
  const req = toConnectRequest(form, keyStored);
  if ('error' in req) return { error: req.error, step: stepError(form, 1, keyStored) ? 1 : 2 };
  let view: RunnerView;
  try {
    view = await deps.connectRunner(req);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), step: 3 };
  }
  if (form.priority !== 'doNotDisturb') {
    try {
      view = await deps.updateRunner(view.config.id, { priority: form.priority });
    } catch (e) {
      deps.pushToast('error', `Connected, but could not set the mode: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { view, form: emptyConnectForm() };
}

const Field = ({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) => (
  <label className="block text-sm font-medium text-ink">
    {label}
    <div className="mt-1">{children}</div>
    {hint && <span className="mt-1 block text-xs font-normal text-ink-faint">{hint}</span>}
  </label>
);

const Choice = ({ name, checked, onChange, title, description }: { name: string; checked: boolean; onChange(): void; title: string; description?: string }) => (
  <label
    className="flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2"
    style={{ borderColor: checked ? 'var(--accent)' : 'var(--line)', background: checked ? 'var(--accent-soft)' : 'var(--surface)' }}
  >
    <input type="radio" name={name} className="mt-0.5" checked={checked} onChange={onChange} />
    <span>
      <span className="block text-sm font-semibold text-ink">{title}</span>
      {description && <span className="block text-xs text-ink-soft">{description}</span>}
    </span>
  </label>
);

const ModeChoices = ({ priority, onPriority }: { priority: Priority; onPriority(p: Priority): void }) => (
  <>
    <div>
      <h3 className="text-base font-semibold text-ink">How should this Mac help?</h3>
      <p className="text-sm text-ink-soft">You can change this any time.</p>
    </div>
    <div role="radiogroup" aria-label="Priority" className="flex flex-col gap-2">
      {PRIORITIES.map((p) => (
        <Choice key={p} name="connect-priority" checked={priority === p} onChange={() => onPriority(p)} title={PRIORITY_LABELS[p]} description={PRIORITY_DESCRIPTIONS[p]} />
      ))}
    </div>
  </>
);

/** The sheet's body for one step (mockup 2); pure so tests render it statically. */
export function ConnectBody({
  step, form, error, busy, onField, onStep, onSubmit,
}: {
  step: ConnectStep;
  form: ConnectForm;
  error: string | null;
  busy: boolean;
  onField<K extends keyof ConnectForm>(key: K, value: ConnectForm[K]): void;
  onStep(step: ConnectStep): void;
  onSubmit(): void;
}) {
  const label = form.label.trim() || DEFAULT_RUNNER_LABEL;
  const scope = form.target.trim() || (form.kind === 'repo' ? 'This repo' : 'This org');
  return (
    <div className="flex flex-col gap-4 p-5">
      <h2 className="text-base font-semibold text-ink">Connect GitHub</h2>
      <ol className="flex flex-wrap gap-2 text-xs">
        {STEPS.map((s, i) => {
          const n = (i + 1) as ConnectStep;
          return (
            <li key={s}>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${n === step ? 'border-transparent font-semibold' : 'border-line text-ink-faint'}`}
                style={n === step ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}
                aria-current={n === step ? 'step' : undefined}
                disabled={busy}
                onClick={() => onStep(n)}
              >
                {n < step && <CheckIcon className="h-3 w-3" />}
                {`${n} ${s}`}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <>
          <p className="text-xs text-ink-soft">
            Create a GitHub App for your account or org, install it, and paste its private key. It is saved in this Mac's keychain only after GitHub accepts it.{' '}
            <a className="text-accent" href={CREATE_APP_DOCS} onClick={(e) => { e.preventDefault(); void window.nekko.openPath(CREATE_APP_DOCS); }}>
              How to create the app <ExternalIcon className="inline h-2.5 w-2.5" />
            </a>
          </p>
          <Field label="App ID"><input className="input w-full" inputMode="numeric" value={form.appId} onChange={(e) => onField('appId', e.target.value)} /></Field>
          <Field label="Installation ID"><input className="input w-full" inputMode="numeric" value={form.installationId} onChange={(e) => onField('installationId', e.target.value)} /></Field>
          <Field label="Private key">
            <textarea
              className="input min-h-28 w-full resize-y font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
              value={form.privateKeyPem}
              onChange={(e) => onField('privateKeyPem', e.target.value)}
            />
          </Field>
        </>
      )}

      {step === 2 && (
        <>
          <div role="radiogroup" aria-label="Org or repo" className="grid grid-cols-2 gap-2">
            <Choice name="connect-kind" checked={form.kind === 'repo'} onChange={() => onField('kind', 'repo')} title="A repo" />
            <Choice name="connect-kind" checked={form.kind === 'org'} onChange={() => onField('kind', 'org')} title="An org" />
          </div>
          {form.kind === 'repo' ? (
            <Field label="Repo"><input className="input w-full" placeholder="owner/name" value={form.target} onChange={(e) => onField('target', e.target.value)} /></Field>
          ) : (
            <>
              <Field label="Org"><input className="input w-full" value={form.target} onChange={(e) => onField('target', e.target.value)} /></Field>
              <Field label="Repos in the org" hint="Comma or newline separated">
                <textarea className="input min-h-16 w-full resize-y" value={form.repos} onChange={(e) => onField('repos', e.target.value)} />
              </Field>
            </>
          )}
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={form.allowPublic} onChange={(e) => onField('allowPublic', e.target.checked)} />
            <span>
              Allow public repos
              <span className="block text-xs text-ink-faint">Anyone can open a pull request on a public repo, and its workflows could ask for this Mac.</span>
            </span>
          </label>
          <Field label="Runner label" hint={<>Use it in <code className="font-mono">{`runs-on: [self-hosted, macOS, ARM64, ${label}]`}</code></>}>
            <input className="input w-full" placeholder={DEFAULT_RUNNER_LABEL} value={form.label} onChange={(e) => onField('label', e.target.value)} />
          </Field>
        </>
      )}

      {step === 3 && (
        <>
          <ModeChoices priority={form.priority} onPriority={(p) => onField('priority', p)} />
          {form.allowPublic && (
            <p className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}>
              {`${scope} may be public. Keep "Require approval for all external contributors" on in the repo's Actions settings so fork pull requests wait for you.`}
            </p>
          )}
        </>
      )}

      {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}

      <div className="flex justify-end gap-2">
        {step > 1 && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onStep((step - 1) as ConnectStep)}>Back</button>}
        {step < 3
          ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onStep((step + 1) as ConnectStep)}>Next</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={onSubmit}>{busy ? 'Starting…' : 'Start runner'}</button>}
      </div>
    </div>
  );
}

const Heading = ({ children }: { children: React.ReactNode }) => <h2 className="text-base font-semibold text-ink">{children}</h2>;
const TextLink = ({ onClick, children }: { onClick(): void; children: React.ReactNode }) => (
  <button type="button" className="self-start text-xs text-accent" onClick={onClick}>{children}</button>
);
const Alert = ({ error }: { error: string | null }) => (error ? <p role="alert" className="text-xs text-[var(--danger)]">{error}</p> : null);

/** The account the sheet will set up. `typed` means its name came from the text box. */
export interface AccountChoice { login: string; kind: 'user' | 'org'; canGroup: boolean | null; typed?: boolean }

/** Frame 2: where the repos live. From `gh` when it is signed in, otherwise one text box. */
export function AccountStep({
  accounts, choice, error, busy, onChoice, onContinue, onManual,
}: {
  accounts: GithubAccounts;
  choice: AccountChoice;
  error: string | null;
  busy: boolean;
  onChoice(c: AccountChoice): void;
  onContinue(repoAdmin: boolean): void;
  onManual(): void;
}) {
  const known = accounts.accounts.length > 0;
  const free = choice.canGroup === false;
  return (
    <div className="flex flex-col gap-3 p-5">
      <Heading>Where do your repos live?</Heading>
      {known && (
        <div role="radiogroup" aria-label="GitHub account" className="flex flex-col gap-2">
          {accounts.accounts.map((a) => (
            <Choice key={a.login} name="github-account" checked={!choice.typed && choice.login === a.login} onChange={() => onChoice(a)} title={a.login} description={a.kind === 'org' ? 'Organization' : 'Your account'} />
          ))}
          <Choice name="github-account" checked={!!choice.typed} onChange={() => onChoice({ login: '', kind: 'org', canGroup: null, typed: true })} title="Another account" description="Type its name" />
        </div>
      )}
      {choice.typed && (
        <>
          <Field label="GitHub account or org">
            <input className="input w-full" autoComplete="off" spellCheck={false} value={choice.login} onChange={(e) => onChoice({ ...choice, login: e.target.value.trim() })} />
          </Field>
          <div role="radiogroup" aria-label="Kind of account" className="grid grid-cols-2 gap-2">
            <Choice name="github-account-kind" checked={choice.kind === 'org'} onChange={() => onChoice({ ...choice, kind: 'org' })} title="An org" />
            <Choice name="github-account-kind" checked={choice.kind === 'user'} onChange={() => onChoice({ ...choice, kind: 'user' })} title="My account" />
          </div>
        </>
      )}
      {free && (
        <p className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}>
          <b>{choice.login}</b> is on GitHub's Free plan, which has no runner groups, so a runner can't be limited to some of its repos. Nekko can connect one repo instead. That app gets the repo's Administration permission.
        </p>
      )}
      <Alert error={error} />
      <div className="flex justify-end">
        <button type="button" className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !choice.login} onClick={() => onContinue(free)}>
          {free ? 'Connect one repo on GitHub' : 'Continue on GitHub'}
        </button>
      </div>
      {choice.kind === 'org' && choice.canGroup === null && choice.login && (
        <TextLink onClick={() => onContinue(true)}>On the Free plan? Connect one repo instead</TextLink>
      )}
      <TextLink onClick={onManual}>Use an app I already have</TextLink>
    </div>
  );
}

const Stage = ({ done, label }: { done: boolean | null; label: string }) => (
  <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 text-sm text-ink">
    {done
      ? <CheckIcon className="h-3.5 w-3.5 justify-self-center text-[var(--success)]" />
      : <span className="h-2.25 w-2.25 justify-self-center rounded-full" style={{ background: done === false ? 'var(--accent)' : 'var(--surface-2)' }} />}
    <span>{label}</span>
    <span className="text-xs text-ink-faint">{done ? 'Done' : done === false ? 'Waiting' : ''}</span>
  </div>
);

/** Frame 3: everything left happens on github.com. Leaving is safe: the app and key are kept. */
export function WaitingStep({ status, busy, onCancel, onOpen }: { status: GithubSetupView; busy: boolean; onCancel(): void; onOpen(): void }) {
  const installing = status.step === 'install';
  return (
    <div className="flex flex-col gap-3 p-5">
      <Heading>Finish on GitHub</Heading>
      <Stage done={installing} label="Create the app" />
      <Stage done={installing ? false : null} label="Choose repos and click Install" />
      <p className="text-xs text-ink-faint">Everything on GitHub is already filled in. This updates by itself.</p>
      {!installing && <p className="text-xs text-ink-faint">If signing in left you on an empty form, close it and choose Open GitHub again.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onOpen}>Open GitHub again</button>
      </div>
    </div>
  );
}

/** Frame 4: repos come from GitHub, so nothing is typed. */
export function ConfirmStep({
  status, picks, error, busy, onTick, onAllowPublic, onLabel, onContinue, onRecheck, onCancel,
}: {
  status: GithubSetupView;
  picks: SetupPicks;
  error: string | null;
  busy: boolean;
  onTick(name: string, on: boolean): void;
  onAllowPublic(allow: boolean): void;
  onLabel(label: string): void;
  onContinue(): void;
  onRecheck(): void;
  onCancel(): void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const one = servesOneRepo(status);
  const anyPublic = publicPicks(status, picks.repos).length > 0;
  const label = picks.label.trim() || DEFAULT_RUNNER_LABEL;
  // Without `gh` a Free org is only found out here. Its app has no repo Administration, so the way out is a new one.
  const stuck = status.kind === 'org' && status.owner && status.slug && error?.includes('runner groups');
  return (
    <div className="flex flex-col gap-3 p-5">
      <Heading>GitHub is connected</Heading>
      <p className="text-sm text-ink-soft">This Mac will serve these repos:</p>
      {!one && status.repos.length > 1 && <p className="text-xs text-ink-faint">{`Tick up to ${MAX_RUNNER_REPOS}.`}</p>}
      <div role={one ? 'radiogroup' : 'group'} aria-label="Repos" className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {status.repos.map((r) => (
          <label key={r.name} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm text-ink">
            <input type={one ? 'radio' : 'checkbox'} name="github-repos" checked={picks.repos.includes(r.name)} onChange={(e) => onTick(r.name, e.target.checked)} />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span className="text-xs text-ink-faint">{r.private ? 'Private' : 'Public'}</span>
          </label>
        ))}
      </div>
      {!status.repos.length && <p className="text-xs text-ink-faint">This app has no repos yet.</p>}
      <div className="flex gap-3">
        {status.slug && <TextLink onClick={() => void window.nekko.openPath(githubInstallUrl(status.slug!))}>Add repos on GitHub</TextLink>}
        <TextLink onClick={onRecheck}>Check again</TextLink>
      </div>
      {anyPublic && (
        <>
          <p className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}>
            <b>Public repo.</b> Anyone can open a pull request, so outside contributors need your approval before their jobs run.
          </p>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2" style={{ borderColor: picks.allowPublic ? 'var(--accent)' : 'var(--line)', background: picks.allowPublic ? 'var(--accent-soft)' : 'var(--surface)' }}>
            <input type="checkbox" className="mt-0.5" checked={picks.allowPublic} onChange={(e) => onAllowPublic(e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold text-ink">Require approval for outside contributors</span>
              <span className="block text-xs text-ink-soft">Nekko sets this on GitHub for you.</span>
            </span>
          </label>
        </>
      )}
      {advanced
        ? (
          <Field label="Runner label" hint={<>Use it in <code className="font-mono">{`runs-on: [self-hosted, macOS, ARM64, ${label}]`}</code></>}>
            <input className="input w-full" placeholder={DEFAULT_RUNNER_LABEL} value={picks.label} onChange={(e) => onLabel(e.target.value)} />
          </Field>
        )
        : <TextLink onClick={() => setAdvanced(true)}>Advanced: runner label</TextLink>}
      <Alert error={error} />
      {stuck && <TextLink onClick={() => void window.nekko.openPath(githubAppSettingsUrl(status.owner!, status.slug!))}>Delete the app on GitHub</TextLink>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-outline" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || !picks.repos.length || (anyPublic && !picks.allowPublic)} onClick={onContinue}>Continue to Mac setup</button>
      </div>
    </div>
  );
}

/** Nekko could not set fork approval. The runner stays off until the owner says it is on. */
export function ForkStep({ url, busy, onOpen, onLeaveOff, onConfirmed }: { url: string; busy: boolean; onOpen(url: string): void; onLeaveOff(): void; onConfirmed(): void }) {
  return (
    <div className="flex flex-col gap-3 p-5">
      <Heading>One more step on GitHub</Heading>
      <p className="text-sm text-ink-soft">
        Nekko couldn't set this for you, so the runner stays off. Turn on <b>Require approval for all external contributors</b>, so fork pull requests wait for you.
      </p>
      <TextLink onClick={() => onOpen(url)}>Open Actions settings <ExternalIcon className="inline h-2.5 w-2.5" /></TextLink>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onLeaveOff}>Leave it off</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirmed}>It is on, continue to Mac setup</button>
      </div>
    </div>
  );
}

export interface SetupDeps {
  connectRunner(req: ConnectRequest): Promise<RunnerView>;
  setForkApproval(req: { runnerId: string; confirmed?: boolean }): Promise<ForkApproval>;
  pushToast(kind: 'error' | 'success' | 'info', message: string): void;
}
export type PendingApproval = ForkApproval & { runnerId: string };

/**
 * Confirm: connect off with the stored key, then settle a public repo's fork
 * approval, all before Mac setup. Only a finished setup turns the runner on, so
 * it can never take a job first. Once connected, a failure only toasts: the
 * daemon keeps the runner off until approval is settled.
 */
export async function submitSetup(
  status: GithubSetupView,
  picks: SetupPicks,
  deps: SetupDeps,
): Promise<{ error: string } | { view: RunnerView; approval: PendingApproval | null }> {
  const req = toSetupRequest(status, picks);
  if ('error' in req) return req;
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let view: RunnerView;
  try {
    view = await deps.connectRunner(req);
  } catch (e) {
    return { error: said(e) };
  }
  if (!req.allowPublic) return { view, approval: null };
  const runnerId = view.config.id;
  try {
    const approval = await deps.setForkApproval({ runnerId });
    return { view, approval: approval.done ? null : { ...approval, runnerId } };
  } catch (e) {
    deps.pushToast('error', `Connected, but the runner stays off: ${said(e)}`);
    return { view, approval: null };
  }
}

/** The owner says approval is on. Settling it is all this does: Mac setup turns the runner on. */
export const confirmFork = (runnerId: string, deps: Pick<SetupDeps, 'setForkApproval'>) => deps.setForkApproval({ runnerId, confirmed: true });

export type SheetScreen = 'manual' | 'account' | 'waiting' | 'confirm' | 'fork';

/** Which screen shows. The daemon owns the setup; this sheet only owns the manual path and the fork step. */
export function sheetScreen({ status, manual, submitting, approval }: { status: GithubSetupView; manual: boolean; submitting: boolean; approval: PendingApproval | null }): SheetScreen {
  if (approval) return 'fork';
  // A connect ends the daemon's setup before fork approval is settled.
  if (submitting) return 'confirm';
  if (manual) return 'manual';
  if (status.step === 'create' || status.step === 'install') return 'waiting';
  if (status.step === 'confirm') return 'confirm';
  return 'account';
}

const NO_ACCOUNTS: GithubAccounts = { login: null, accounts: [] };
const TYPED: AccountChoice = { login: '', kind: 'org', canGroup: null, typed: true };

/** The Connect GitHub sheet. The pasted key lives only in this sheet's form, and only until it closes or connects. */
/** `onConnected` gets the new runner's id when it goes on to Mac setup; the manual path starts its runner itself. */
export function ConnectRunnerSheet({ onClose, onConnected, beginReply, keyStoredFor }: { onClose(): void; onConnected(runnerId?: string): void; beginReply(): (v: RunnerView) => void; keyStoredFor: (appId: number) => boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const [form, setForm] = useState(emptyConnectForm);
  const [step, setStep] = useState<ConnectStep>(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [status, setStatus] = useState<GithubSetupView>(IDLE_GITHUB_SETUP);
  const [accounts, setAccounts] = useState<GithubAccounts>(NO_ACCOUNTS);
  const [choice, setChoice] = useState<AccountChoice>(TYPED);
  const [picks, setPicks] = useState<SetupPicks>({ repos: [], allowPublic: false, label: '' });
  const [submitting, setSubmitting] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);

  // Rejects on a daemon that predates this: the sheet then stays on the account step, and the manual path still works.
  useEffect(() => {
    let live = true;
    void window.nekko.githubAccounts().then((a) => {
      if (!live) return;
      setAccounts(a);
      if (a.accounts.length) setChoice((c) => (c.login ? c : a.accounts[0]));
    }, () => {});
    void window.nekko.githubStatus().then((v) => { if (live) setStatus(v); }, () => {});
    const off = window.nekko.onGithubSetupChanged(setStatus);
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (status.step === 'confirm') setPicks((p) => ({ ...p, repos: defaultRepoPicks(status) }));
  }, [status]);

  const close = () => {
    setForm(emptyConnectForm());
    onClose();
  };
  const open = (url: string | null) => { if (url) void window.nekko.openPath(url); };
  /** Asks the daemon for the page to open; it never makes a second app for the same owner. */
  const start = async (req: { owner: string; kind: 'user' | 'org'; repoAdmin: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      open((await window.nekko.githubStart(req)).url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const again = () => void start({ owner: status.owner ?? '', kind: status.kind ?? 'org', repoAdmin: status.repoAdmin });
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setSubmitting(true);
    setError(null);
    const reply = beginReply();
    const res = await submitSetup(status, picks, { connectRunner: window.nekko.connectRunner, setForkApproval: window.nekko.setForkApproval, pushToast });
    setBusy(false);
    setSubmitting(false);
    if ('error' in res) {
      setError(res.error);
      return;
    }
    reply(res.view);
    if (res.approval) setApproval(res.approval);
    else onConnected(res.view.config.id);
  };
  const approved = async () => {
    if (!approval) return;
    setBusy(true);
    try {
      await confirmFork(approval.runnerId, window.nekko);
      onConnected(approval.runnerId);
    } catch (e) {
      pushToast('error', `Could not save that: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(false);
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const reply = beginReply();
    const res = await submitConnect(form, { connectRunner: window.nekko.connectRunner, updateRunner: window.nekko.updateRunner, pushToast }, keyStoredFor(Number(form.appId.trim())));
    setBusy(false);
    if ('error' in res) {
      setError(res.error);
      setStep(res.step);
      return;
    }
    setForm(res.form);
    reply(res.view);
    onConnected();
  };

  const screen = sheetScreen({ status, manual, submitting, approval });
  // A connect ends the daemon's setup, and with it the repos on screen, while fork approval settles.
  const held = useRef(status);
  if (!submitting) held.current = status;
  return (
    <Modal title="Connect GitHub" onClose={close} overlayClassName="p-4" className="card w-[560px] max-w-[94vw] max-h-[90vh] overflow-y-auto shadow-(--shadow-float)">
      {screen === 'manual' && (
        <ConnectBody
          step={step}
          form={form}
          error={error}
          busy={busy}
          onField={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
          onStep={(s) => {
            // Moving forward checks the steps being left; the error shows here without moving.
            const err = s > step ? stepError(form, (s - 1) as 1 | 2, keyStoredFor(Number(form.appId.trim()))) : null;
            setError(err);
            if (!err) setStep(s);
          }}
          onSubmit={() => void submit()}
        />
      )}
      {screen === 'account' && (
        <AccountStep
          accounts={accounts}
          choice={choice}
          error={error ?? status.error}
          busy={busy}
          onChoice={setChoice}
          onContinue={(repoAdmin) => void start({ owner: choice.login, kind: choice.kind, repoAdmin })}
          onManual={() => { setError(null); setManual(true); }}
        />
      )}
      {screen === 'waiting' && <WaitingStep status={status} busy={busy} onCancel={() => void window.nekko.githubCancel()} onOpen={again} />}
      {screen === 'confirm' && (
        <ConfirmStep
          status={held.current}
          picks={picks}
          error={error}
          busy={busy}
          onTick={(name, on) => {
            const res = tickRepo(status, picks.repos, name, on);
            setError(res.error);
            setPicks((p) => ({ ...p, repos: res.picked }));
          }}
          onAllowPublic={(allowPublic) => setPicks((p) => ({ ...p, allowPublic }))}
          onLabel={(label) => setPicks((p) => ({ ...p, label }))}
          onContinue={() => void confirm()}
          onRecheck={again}
          onCancel={() => void window.nekko.githubCancel()}
        />
      )}
      {screen === 'fork' && approval && <ForkStep url={approval.url} busy={busy} onOpen={open} onLeaveOff={close} onConfirmed={() => void approved()} />}
    </Modal>
  );
}
