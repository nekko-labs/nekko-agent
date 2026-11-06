import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrivacyFinding, PrivacyKind, PrivacyPreview, Session, SessionPrivacy } from '@nekko-agent/shared';
import { PRIVACY_KINDS, PRIVACY_KIND_LABELS, patchPrivacy, privacyMode, toggleAllowed } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { ShieldIcon } from '../icons.js';
import { useFloatingMenu } from './floatingMenu.js';

/** How long the draft must sit still before the preview asks the engine again. */
const PREVIEW_DEBOUNCE_MS = 250;

/** The kind, in the few letters a list row has room for. */
const KIND_SHORT: Record<PrivacyKind, string> = {
  email: 'Email', phone: 'Phone', card: 'Card', ssn: 'SSN', 'my-number': 'My Number',
  ip: 'IP', secret: 'Secret', username: 'Account', term: 'Term',
};

const REACH_NOTE: Record<PrivacyPreview['reach'], string | null> = {
  cloud: null,
  local: "This chat's model runs on this computer. Nothing leaves it, so the shield has nothing to hide.",
  external: 'Claude subscription chats are sent by Claude Code itself, out of the shield’s reach. Use another provider to shield a chat.',
};

/**
 * Privacy Shield, beside Incognito: switch it on for this chat, and see
 * exactly what a cloud model would read. Every value the engine would swap
 * for a placeholder is listed with what the model gets instead; each can be
 * sent as it is, each kind switched off, and the user's own terms (clients,
 * codenames, names) added for every chat. The preview is the engine's own
 * redaction (`privacy:preview`), not a copy of it, so what it shows is what
 * goes out.
 */
export function PrivacyShieldMenu({
  session,
  draft = '',
  onChange,
}: {
  session: Session;
  /** The message being written, so the preview covers it too. */
  draft?: string;
  onChange: (s: Session | null) => void;
}) {
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PrivacyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const floating = useFloatingMenu(open, button, 440, 640);
  const on = privacyMode(session, settings) === 'redact';

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus({ preventScroll: true }); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Ask again whenever what would be sent, or what the shield covers, changes:
  // while the panel is open, and while the shield is on (for the count on the button).
  useEffect(() => {
    if (!open && !on) return;
    let live = true;
    const timer = setTimeout(() => {
      window.nekko.previewPrivacy(session.id, draft)
        .then((p) => { if (live) { setPreview(p); setError(null); } })
        .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    }, open ? PREVIEW_DEBOUNCE_MS : PREVIEW_DEBOUNCE_MS * 3);
    return () => { live = false; clearTimeout(timer); };
  }, [open, on, session.id, draft, session.privacy, session.messages?.length, settings?.privacyMode, settings?.privacyTerms, settings?.privacyDisabledKinds]);

  const patch = async (p: Partial<SessionPrivacy>) =>
    onChange(await window.nekko.setSessionOptions(session.id, { privacy: patchPrivacy(session.privacy, p) }));
  const disabled = new Set<PrivacyKind>(preview?.disabledKinds ?? session.privacy?.disabledKinds ?? settings?.privacyDisabledKinds ?? []);
  const toggleKind = (k: PrivacyKind) => {
    const next = new Set(disabled);
    if (next.has(k)) next.delete(k); else next.add(k);
    return patch({ disabledKinds: PRIVACY_KINDS.filter((x) => next.has(x)) });
  };
  const setAllowed = (value: string, allowed: boolean) => patch({ allow: toggleAllowed(session.privacy?.allow, value, allowed) });
  const terms = settings?.privacyTerms ?? [];
  const saveTerms = async (next: string[]) => {
    await window.nekko.updateSettings({ privacyTerms: next });
    await useStore.getState().refreshSettings();
  };

  const count = on && preview?.reach === 'cloud' ? preview.findings.length : 0;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={button}
        data-privacy-shield-button
        className="ctl-toggle ctl-toggle-neutral whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={on}
        title={on ? 'Privacy Shield is on: private values are replaced before a cloud model sees them' : 'Privacy Shield: see and control what a cloud model receives'}
      >
        <span className="ctl-dot" />
        <ShieldIcon className="h-3.5 w-3.5" /> <span className="foot-label">Shield</span>
        {count > 0 && <span className="tabular-nums text-2xs text-ink-faint">{count}</span>}
      </button>
      {open && createPortal(
        <div ref={pop} style={floating} data-privacy-shield-panel
          className="card fixed z-[100] overflow-y-auto p-3 text-xs shadow-(--shadow-float)" role="dialog" aria-label="Privacy Shield">
          <PrivacyShieldPanel
            on={on}
            preview={preview}
            error={error}
            draft={draft}
            terms={terms}
            disabled={disabled}
            onToggleShield={() => void patch({ mode: on ? 'off' : 'redact' })}
            onAllow={(value, allowed) => void setAllowed(value, allowed)}
            onToggleKind={(k) => void toggleKind(k)}
            onTerms={(next) => void saveTerms(next)}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The panel's content, given the engine's preview: what is hidden, and the controls over it. */
export function PrivacyShieldPanel({
  on,
  preview,
  error,
  draft,
  terms,
  disabled,
  onToggleShield,
  onAllow,
  onToggleKind,
  onTerms,
}: {
  on: boolean;
  preview: PrivacyPreview | null;
  error: string | null;
  draft: string;
  /** The user's own terms (every chat). */
  terms: string[];
  /** Kinds this chat sends as written. */
  disabled: Set<PrivacyKind>;
  onToggleShield: () => void;
  onAllow: (value: string, allowed: boolean) => void;
  onToggleKind: (kind: PrivacyKind) => void;
  onTerms: (next: string[]) => void;
}) {
  const [showSent, setShowSent] = useState(false);
  const [term, setTerm] = useState('');
  const findings = preview?.findings ?? [];
  const reachNote = preview ? REACH_NOTE[preview.reach] : null;
  const addTerm = () => {
    const t = term.trim();
    if (t.length < 2 || terms.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    setTerm('');
    onTerms([...terms, t]);
  };
  return (<>
    <div className="flex items-start gap-2">
      <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">Privacy Shield</div>
        <p className="text-2xs text-ink-faint">
          Replaces private values with placeholders before a request leaves this computer, and puts the real values back in the reply. Tools and this chat keep the real values.
        </p>
      </div>
      <Switch on={on} label="Shield this chat" onToggle={onToggleShield} />
    </div>

    {reachNote && <p className="mt-2 rounded-md bg-surface-2 px-2 py-1 text-2xs text-ink-faint">{reachNote}</p>}
    {error && <p className="mt-2 text-2xs text-danger">Could not preview: {error}</p>}

    <Section title={on ? 'What the model reads instead' : 'What the shield would hide'}>
      {!preview && !error && <p className="text-2xs text-ink-faint">Checking…</p>}
      {preview && findings.length === 0 && <p className="text-2xs text-ink-faint">Nothing private found in this chat or your draft.</p>}
      {findings.length > 0 && (
        <ul className="space-y-0.5" aria-label="Values the shield replaces">
          {findings.map((f) => <FindingRow key={f.token} finding={f} on={on} onSend={() => onAllow(f.value, true)} />)}
        </ul>
      )}
    </Section>

    {preview && preview.allowed.length > 0 && (
      <Section title="Sent as written (you allowed these)">
        <ul className="space-y-0.5">
          {preview.allowed.map((a) => (
            <li key={a.value} className="flex items-center gap-2">
              <span className="w-16 shrink-0 truncate text-2xs text-ink-faint" title={PRIVACY_KIND_LABELS[a.kind]}>{KIND_SHORT[a.kind]}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">{a.value}</span>
              <button className="text-2xs text-accent hover:underline" onClick={() => onAllow(a.value, false)}>Hide again</button>
            </li>
          ))}
        </ul>
      </Section>
    )}

    {draft.trim() !== '' && preview && (
      <Section title="Your message as the model reads it">
        <button className="text-2xs text-accent hover:underline" aria-expanded={showSent} onClick={() => setShowSent((s) => !s)}>
          {showSent ? 'Hide' : 'Show'}
        </button>
        {showSent && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-2xs" data-privacy-sent>
            {on && preview.reach === 'cloud' ? preview.draft : draft}
          </pre>
        )}
      </Section>
    )}

    <Section title="Hide in this chat">
      <div className="flex flex-wrap gap-1">
        {PRIVACY_KINDS.map((k) => (
          <button key={k} className="ctl-toggle ctl-toggle-neutral text-2xs" aria-pressed={!disabled.has(k)} onClick={() => onToggleKind(k)}>
            <span className="ctl-dot" />{PRIVACY_KIND_LABELS[k]}
          </button>
        ))}
      </div>
    </Section>

    <Section title="Your terms (every chat)">
      <p className="mb-1 text-2xs text-ink-faint">Clients, codenames, people: always replaced when the shield is on.</p>
      <div className="flex flex-wrap gap-1">
        {terms.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-2xs">
            {t}
            <button aria-label={`Remove ${t}`} className="text-ink-faint hover:text-ink" onClick={() => onTerms(terms.filter((x) => x !== t))}>×</button>
          </span>
        ))}
      </div>
      <form className="mt-1 flex gap-1" onSubmit={(e) => { e.preventDefault(); addTerm(); }}>
        <input
          className="input min-w-0 flex-1 px-2 py-1 text-xs"
          value={term}
          placeholder="Add a term, e.g. Acme Corp"
          onChange={(e) => setTerm(e.target.value)}
          aria-label="New term to hide"
        />
        <button type="submit" className="btn px-2 py-1 text-xs" disabled={term.trim().length < 2}>Add</button>
      </form>
    </Section>

    <p className="mt-3 text-2xs text-ink-faint">
      Detection runs on this computer and is pattern-based: it can miss things (a name in prose, an address) and catch harmless ones. Read the list before sending anything sensitive.
    </p>
  </>);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium text-ink-soft">{title}</div>
      {children}
    </div>
  );
}

function FindingRow({ finding, on, onSend }: { finding: PrivacyFinding; on: boolean; onSend: () => void }) {
  const where = [finding.inDraft && 'draft', finding.inChat && 'chat'].filter(Boolean).join(' · ');
  return (
    <li className="flex items-center gap-2" data-privacy-finding={finding.kind}>
      <span className="w-16 shrink-0 truncate text-2xs text-ink-faint" title={PRIVACY_KIND_LABELS[finding.kind]}>{KIND_SHORT[finding.kind]}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-2xs" title={finding.value}>{finding.value}</span>
      <span className="shrink-0 text-ink-faint" aria-hidden="true">→</span>
      <span className={`w-32 shrink-0 truncate font-mono text-2xs ${on ? 'text-accent' : 'text-ink-faint line-through'}`} title={on ? 'What the model reads' : 'Shield is off: sent as written'}>{finding.token}</span>
      <span className="w-14 shrink-0 text-right text-2xs text-ink-faint" title={`${finding.count} time(s)`}>{where}</span>
      <button className="shrink-0 text-2xs text-accent hover:underline" onClick={onSend} title="Send this value as it is in this chat">Send</button>
    </li>
  );
}

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} title={label} onClick={onToggle}
      className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
      style={{ background: on ? 'var(--accent)' : 'color-mix(in srgb, var(--ink-faint) 40%, transparent)' }}>
      <span className="absolute h-3 w-3 rounded-full bg-white shadow-(--shadow-sm) transition-transform" style={{ transform: on ? 'translateX(14px)' : 'translateX(2px)' }} />
    </button>
  );
}
