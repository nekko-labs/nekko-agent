import React, { useState } from 'react';
import {
  DEFAULT_RUNNER_LABEL,
  PRIORITY_DESCRIPTIONS,
  PRIORITY_LABELS,
  toConnectRequest,
  type ConnectForm,
  type ConnectRequest,
  type Priority,
  type RunnerSettings,
  type RunnerView,
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
  <label className="block text-[13px] font-medium text-ink">
    {label}
    <div className="mt-1">{children}</div>
    {hint && <span className="mt-1 block text-[11.5px] font-normal text-ink-faint">{hint}</span>}
  </label>
);

const Choice = ({ name, checked, onChange, title, description }: { name: string; checked: boolean; onChange(): void; title: string; description?: string }) => (
  <label
    className="flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5"
    style={{ borderColor: checked ? 'var(--accent)' : 'var(--line)', background: checked ? 'var(--accent-soft)' : 'var(--surface)' }}
  >
    <input type="radio" name={name} className="mt-0.5" checked={checked} onChange={onChange} />
    <span>
      <span className="block text-[13px] font-semibold text-ink">{title}</span>
      {description && <span className="block text-[12px] text-ink-soft">{description}</span>}
    </span>
  </label>
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
    <div className="flex flex-col gap-3.5 p-5">
      <h2 className="text-[17px] font-semibold text-ink">Connect GitHub</h2>
      <ol className="flex flex-wrap gap-1.5 text-[12px]">
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
          <p className="text-[12.5px] text-ink-soft">
            Create a GitHub App for your account or org, install it, and paste its private key. It is saved in this Mac's keychain only after GitHub accepts it.{' '}
            <a className="text-accent" href={CREATE_APP_DOCS} onClick={(e) => { e.preventDefault(); void window.nekko.openPath(CREATE_APP_DOCS); }}>
              How to create the app <ExternalIcon className="inline h-2.5 w-2.5" />
            </a>
          </p>
          <Field label="App ID"><input className="input w-full" inputMode="numeric" value={form.appId} onChange={(e) => onField('appId', e.target.value)} /></Field>
          <Field label="Installation ID"><input className="input w-full" inputMode="numeric" value={form.installationId} onChange={(e) => onField('installationId', e.target.value)} /></Field>
          <Field label="Private key">
            <textarea
              className="input min-h-28 w-full resize-y font-mono text-[11.5px]"
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
          <label className="flex items-start gap-2 text-[13px] text-ink">
            <input type="checkbox" className="mt-0.5" checked={form.allowPublic} onChange={(e) => onField('allowPublic', e.target.checked)} />
            <span>
              Allow public repos
              <span className="block text-[11.5px] text-ink-faint">Anyone can open a pull request on a public repo, and its workflows could ask for this Mac.</span>
            </span>
          </label>
          <Field label="Runner label" hint={<>Use it in <code className="font-mono">{`runs-on: [self-hosted, macOS, ARM64, ${label}]`}</code></>}>
            <input className="input w-full" placeholder={DEFAULT_RUNNER_LABEL} value={form.label} onChange={(e) => onField('label', e.target.value)} />
          </Field>
        </>
      )}

      {step === 3 && (
        <>
          <div>
            <h3 className="text-[15px] font-semibold text-ink">How should this Mac help?</h3>
            <p className="text-[13px] text-ink-soft">You can change this any time.</p>
          </div>
          <div role="radiogroup" aria-label="Priority" className="flex flex-col gap-2">
            {PRIORITIES.map((p) => (
              <Choice key={p} name="connect-priority" checked={form.priority === p} onChange={() => onField('priority', p)} title={PRIORITY_LABELS[p]} description={PRIORITY_DESCRIPTIONS[p]} />
            ))}
          </div>
          {form.allowPublic && (
            <p className="rounded-xl border px-3 py-2 text-[12.5px]" style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}>
              {`${scope} may be public. Keep "Require approval for all outside collaborators" on in the repo's Actions settings so fork pull requests wait for you.`}
            </p>
          )}
        </>
      )}

      {error && <p role="alert" className="text-[12.5px] text-[var(--danger)]">{error}</p>}

      <div className="flex justify-end gap-2">
        {step > 1 && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onStep((step - 1) as ConnectStep)}>Back</button>}
        {step < 3
          ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onStep((step + 1) as ConnectStep)}>Next</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={onSubmit}>{busy ? 'Starting…' : 'Start runner'}</button>}
      </div>
    </div>
  );
}

/** The Connect GitHub sheet. The pasted key lives only in this sheet's form, and only until it closes or connects. */
export function ConnectRunnerSheet({ onClose, onConnected, beginReply, keyStoredFor }: { onClose(): void; onConnected(): void; beginReply(): (v: RunnerView) => void; keyStoredFor: (appId: number) => boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const [form, setForm] = useState(emptyConnectForm);
  const [step, setStep] = useState<ConnectStep>(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setForm(emptyConnectForm());
    onClose();
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

  return (
    <Modal title="Connect GitHub" onClose={close} overlayClassName="p-4" className="card w-[560px] max-w-[94vw] max-h-[90vh] overflow-y-auto shadow-xl">
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
    </Modal>
  );
}
