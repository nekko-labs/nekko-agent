import React, { useEffect, useRef, useState } from 'react';
import { hasAppChrome } from '../../chrome.js';
import { CheckIcon, ExternalIcon } from '../../icons.js';
import { looksLikeKey, type KeySource } from './providerPresets.js';

export type KeyCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'failed'; message: string }
  | { state: 'connected' };

type StepState = 'done' | 'active' | 'waiting';

/** Where each of the three steps stands, from what the person has done so far. */
export function keyFlowSteps({ opened, hasKey, check }: { opened: boolean; hasKey: boolean; check: KeyCheck }): [StepState, StepState, StepState] {
  if (check.state === 'connected') return ['done', 'done', 'done'];
  const tried = check.state !== 'idle';
  return [
    opened || hasKey ? 'done' : 'active',
    // A key the person already has can go straight in, so the field is live from the start.
    hasKey && tried ? 'done' : 'active',
    hasKey ? 'active' : 'waiting',
  ];
}

/**
 * The guided way to connect a key-based provider: open its key page, bring
 * the key back, and Nekko checks it and connects by itself. On the desktop a
 * key of the right shape is picked up from the clipboard when the window comes
 * back into focus after the key page was opened; nothing else on the clipboard
 * is kept or sent. A browser tab never reads the clipboard without a press,
 * so there the person pastes.
 */
export function KeyFlow({ name, source, value, onChange, onConnect, check }: {
  name: string;
  source: KeySource;
  value: string;
  onChange: (key: string) => void;
  /** Check the key and save the provider. */
  onConnect: (key: string) => void;
  check: KeyCheck;
}) {
  const [opened, setOpened] = useState(false);
  // The last key handed to onConnect, so a failed key is not retried by itself.
  const tried = useRef<string | null>(null);
  const checking = check.state === 'checking';
  const connect = (raw: string) => {
    const key = raw.trim();
    if (!key || checking) return;
    tried.current = key;
    onConnect(key);
  };
  // A pasted or picked-up key checks itself when it has the key's shape; a
  // service without a known shape checks any pasted text.
  const take = (raw: string) => {
    const key = raw.trim();
    onChange(key);
    if (key && key !== tried.current && (looksLikeKey(source, key) || !source.pattern)) connect(key);
  };
  const takeRef = useRef(take);
  takeRef.current = take;

  useEffect(() => {
    if (!hasAppChrome || !opened || value.trim() || !source.pattern) return;
    const pick = () => {
      void navigator.clipboard?.readText?.().then((text) => {
        if (looksLikeKey(source, text)) takeRef.current(text);
      }).catch(() => {});
    };
    window.addEventListener('focus', pick);
    return () => window.removeEventListener('focus', pick);
  }, [opened, value, source]);

  const open = () => {
    setOpened(true);
    // Desktop maps this to shell.openExternal; the web build window.open()s it.
    void window.nekko.openPath(source.url).catch(() => {});
  };
  const paste = () => { void navigator.clipboard?.readText?.().then(take).catch(() => {}); };
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

  const [get, bring, done] = keyFlowSteps({ opened, hasKey: !!value.trim(), check });
  const failed = check.state === 'failed' ? check.message : null;
  return (
    <ol className="key-flow" aria-label={`Connect ${name}`}>
      <KeyStep n={1} state={get} title={`Get a key from ${source.site}`} detail={source.how}>
        <button type="button" className={`btn ${get === 'active' ? 'btn-primary' : ''}`} onClick={open}>
          {opened ? `Open ${source.site} again` : `Open ${source.site}`}<ExternalIcon className="h-3.5 w-3.5" />
        </button>
      </KeyStep>
      <KeyStep
        n={2}
        state={bring}
        title="Bring the key back"
        detail={opened && hasAppChrome && source.pattern && !value ? 'Copy it and come back. Nekko picks it up.' : 'Paste it here. Nekko checks it right away.'}
      >
        <div className="key-flow-field">
          <input
            className="quiet-field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${name} API key`}
            placeholder={`${name} API key`}
            value={value}
            disabled={checking}
            onChange={(e) => onChange(e.target.value)}
            onPaste={(e) => { const text = e.clipboardData.getData('text'); if (text) { e.preventDefault(); take(text); } }}
            onKeyDown={(e) => { if (e.key === 'Enter') connect(value); }}
          />
          {canPaste && !value && <button type="button" className="btn" onClick={paste}>Paste</button>}
        </div>
      </KeyStep>
      <KeyStep
        n={3}
        state={done}
        working={checking}
        title={check.state === 'connected' ? `${name} is connected` : 'Connect'}
        detail={checking ? 'Checking your key…' : failed ?? (check.state === 'connected' ? 'Its models are in the model picker now.' : 'Nekko checks the key and connects by itself.')}
        tone={failed ? 'danger' : undefined}
      >
        {done === 'active' && !checking && (check.state === 'failed' || tried.current !== value.trim()) && (
          <button type="button" className="btn btn-primary" onClick={() => connect(value)}>{failed ? 'Try again' : 'Connect'}</button>
        )}
      </KeyStep>
    </ol>
  );
}

function KeyStep({ n, state, working = false, title, detail, tone, children }: {
  n: number;
  state: StepState;
  working?: boolean;
  title: string;
  detail: string;
  tone?: 'danger';
  children?: React.ReactNode;
}) {
  return (
    <li className="key-flow-step" data-state={state} data-working={working || undefined} aria-current={state === 'active' ? 'step' : undefined}>
      <span className="key-flow-mark" aria-hidden="true">
        {state === 'done' ? <CheckIcon className="h-3.5 w-3.5" /> : working ? <span className="claude-spin" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="key-flow-title">{title}</p>
        <p key={detail} className="key-flow-detail" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>{detail}</p>
        {children && <div className="key-flow-action">{children}</div>}
      </div>
    </li>
  );
}
