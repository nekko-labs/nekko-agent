import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { CHAT_MODE_LABEL, getExecutionMode, patchPrivacy, privacyMode, type ChatMode, type Session } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { saveSettings } from '../settingsIndex.js';
import { CheckIcon, GlobeIcon, GlobeOffIcon, IncognitoIcon, InfoIcon, ShieldIcon } from '../icons.js';
import { CHAT_MODE_ICON } from '../gentleface-icons.js';
import { usePopover } from './ModeViews.js';
import { allowModeChange } from './YoloWarning.js';

/** A chat's approvals in plain words. Same values, behaviour and icons as the Mode panel's Approvals tiles. */
export const ASKS_FIRST: ReadonlyArray<{ mode: ChatMode; label: string; hint: string; icon: (p: { className?: string }) => React.ReactElement }> = [
  { mode: 'ask', label: CHAT_MODE_LABEL.ask, hint: 'Checks with you before it changes a file or runs a command.', icon: CHAT_MODE_ICON.ask },
  { mode: 'guardrails', label: CHAT_MODE_LABEL.guardrails, hint: 'Edits files and runs read-only commands freely, and asks before any other command.', icon: CHAT_MODE_ICON.guardrails },
  { mode: 'yolo', label: CHAT_MODE_LABEL.yolo, hint: 'Runs everything, except what your rules block.', icon: CHAT_MODE_ICON.yolo },
];

/** Wide enough that each hint sits on one line; the floating menu narrows it to fit a small window. */
export const ASKS_MENU_WIDTH = 400;

export type PrivacyToggleKey = 'incognito' | 'shield' | 'internet';

/** A named permission row, backed by the chat's existing setting. */
export type PrivacyToggle = { key: PrivacyToggleKey; label: string; on: boolean; disabled: boolean; title: string };

/**
 * The menu's privacy rows: Incognito, Privacy Shield and Internet access.
 * Each mirrors the chat's own setting (the same ones the Mode
 * panel and the strip above the box change), so turning one here turns it
 * everywhere.
 */
export function privacyToggles(session: Session, opts: { shieldOn: boolean; isCloudModel: boolean }): PrivacyToggle[] {
  const incognito = !!session.incognito;
  const online = !session.offline;
  // A cloud model needs the internet, so it can only be switched off with a local model.
  const internetLocked = opts.isCloudModel && online;
  return [
    { key: 'incognito', label: 'Incognito', on: incognito, disabled: false,
      title: incognito ? 'Incognito is on: this chat is not saved and memory is not read or updated. New chats start without it.' : 'Incognito: don’t save this chat or use memory. For this chat only.' },
    { key: 'shield', label: 'Privacy Shield', on: opts.shieldOn, disabled: false,
      title: opts.shieldOn ? 'Privacy Shield is on: private values are replaced before a cloud model sees them' : 'Privacy Shield: replace private values before a cloud model sees them' },
    { key: 'internet', label: 'Internet access', on: online, disabled: internetLocked,
      title: internetLocked ? 'This cloud model needs an internet connection, so internet access stays on. Pick a local model to block it.'
        : online ? 'Internet access is on: web tools, connectors and MCP can reach the internet'
          : 'Internet access is off: online tools, connectors and MCP are off' },
  ];
}

const TOGGLE_ICON: Record<PrivacyToggleKey, (on: boolean, className?: string) => React.ReactElement> = {
  incognito: (_on, className = 'h-3.5 w-3.5') => <IncognitoIcon className={className} />,
  shield: (_on, className = 'h-3.5 w-3.5') => <ShieldIcon className={className} />,
  internet: (on, className = 'h-3.5 w-3.5') => (on ? <GlobeIcon className={className} /> : <GlobeOffIcon className={className} />),
};

/**
 * The switches the closed menu shows beside the approvals icon: Incognito and
 * Privacy Shield when on, and Internet access when off. Internet access is on
 * for nearly every chat, so its globe only marks the departure from that.
 */
export function permissionMarks(toggles: PrivacyToggle[]): Array<{ key: PrivacyToggleKey; on: boolean; label: string }> {
  return toggles.filter((t) => (t.key === 'internet' ? !t.on : t.on))
    .map((t) => ({ key: t.key, on: t.on, label: t.key === 'internet' ? 'Internet access off' : t.label }));
}

export const PRIVACY_SHIELD_DOCS = 'https://nekkoagent.com/docs/privacy-shield';

const PERMISSION_DETAIL: Record<PrivacyToggleKey, string> = {
  incognito: 'This chat is not saved. Memory is neither read nor updated. This does not change what your model provider retains.',
  shield: 'Replaces recognized private values with placeholders before supported cloud requests. It does not hide attached images or protect Claude Agent chats. Pattern matching cannot catch everything.',
  internet: 'Controls online tools, connectors and MCP for this chat. A cloud model needs internet access; choose a local model to turn it off.',
};

/** Info is a separate action: opening it never changes a permission. */
export function PermissionRows({ toggles, onToggle, busy = false }: { toggles: PrivacyToggle[]; onToggle: (key: PrivacyToggleKey) => void; busy?: boolean }) {
  const [detail, setDetail] = useState<PrivacyToggleKey | null>(null);
  const id = useId();
  return (
    <div className="permission-rows" role="group" aria-label="Privacy and internet" data-asks-toggles>
      {toggles.map((t) => (
        <div key={t.key} role="none">
          <div className="permission-row" role="none">
            {/* A locked row is aria-disabled, not disabled, so it still hovers and its title says why. */}
            <button type="button" role="menuitemcheckbox" aria-checked={t.on} aria-label={t.label} title={t.title}
              disabled={busy} aria-disabled={t.disabled || undefined} data-asks-toggle={t.key} className="permission-choice"
              onClick={() => { if (!t.disabled) onToggle(t.key); }}>
              <span className="permission-check" aria-hidden="true">{t.on && <CheckIcon className="h-3.5 w-3.5" />}</span>
              <span className="permission-glyph" aria-hidden="true">{TOGGLE_ICON[t.key](t.on)}</span>
              <span className="min-w-0 truncate">{t.label}</span>
            </button>
            <button type="button" role="menuitem" className="permission-info" aria-label={'About ' + t.label} aria-expanded={detail === t.key}
              aria-controls={id + '-' + t.key} data-asks-info={t.key} onClick={() => setDetail(detail === t.key ? null : t.key)}>
              <InfoIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {detail === t.key && <div id={id + '-' + t.key} className="permission-detail" data-asks-detail={t.key}>
            <p>{PERMISSION_DETAIL[t.key]}</p>
            {t.disabled && <p className="mt-1">{t.title}</p>}
            {t.key === 'shield' && <a className="mt-2 inline-block text-accent hover:underline" href={PRIVACY_SHIELD_DOCS} target="_blank" rel="noreferrer"
              onClick={(e) => { e.preventDefault(); void window.nekko.openPath(PRIVACY_SHIELD_DOCS).catch((error) => useStore.getState().pushToast('error', String(error))); }}>Read the Privacy Shield guide</a>}
          </div>}
        </div>
      ))}
    </div>
  );
}

/** A chat's approvals: one choice, in the row under the message box. */
export function AsksFirstMenu({ session, onChange, iconOnly = false, isCloudModel = true }: { iconOnly?: boolean; session: Session; onChange: (s: Session | null) => void; isCloudModel?: boolean }) {
  const fallback = useStore((s) => s.settings?.defaultChatMode);
  const settings = useStore((s) => s.settings);
  const pop = usePopover(ASKS_MENU_WIDTH, 560);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pop.open) pop.pop.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  }, [pop.open]);
  // A sandbox always asks, so there is no approval to choose there; the switches below still apply.
  const sandbox = getExecutionMode(session) === 'sandbox';
  const mode: ChatMode = sandbox ? 'ask' : session.mode ?? fallback ?? 'guardrails';
  const current = ASKS_FIRST.find((o) => o.mode === mode) ?? ASKS_FIRST[1];
  const shieldOn = privacyMode(session, settings) === 'redact';
  const toggles = privacyToggles(session, { shieldOn, isCloudModel });
  const marks = permissionMarks(toggles);
  const marksText = marks.map((m) => m.label).join(', ');
  const pick = async (next: ChatMode) => {
    pop.setOpen(false);
    if (next === mode) return;
    if (!await allowModeChange(mode, next)) return;
    try {
      const updated = await window.nekko.setSessionOptions(session.id, { mode: next });
      onChange(updated);
      if (updated) await saveSettings({ defaultChatMode: next });
    } catch (e) { useStore.getState().pushToast('error', String(e)); }
  };
  // The switches keep the menu open, so several can be set in one visit.
  const flip = async (key: PrivacyToggleKey) => {
    if (busy || toggles.find((t) => t.key === key)?.disabled) return;
    setBusy(true);
    const patch: Partial<Session> = key === 'incognito' ? { incognito: !session.incognito }
      : key === 'shield' ? { privacy: patchPrivacy(session.privacy, { mode: shieldOn ? 'off' : 'redact' }) }
        : { offline: !session.offline };
    try { onChange(await window.nekko.setSessionOptions(session.id, patch as never)); } catch (e) { useStore.getState().pushToast('error', String(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <button ref={pop.anchor} type="button" className={`ctl-menu min-w-0 whitespace-nowrap ${iconOnly ? 'composer-permissions' : ''}`} aria-label={`Permissions: ${current.label}${marks.length ? `, ${marksText}` : ''}`} data-asks-first={mode} aria-haspopup="menu" aria-expanded={pop.open} title={(sandbox ? 'A sandbox always asks' : `${current.label}: ${current.hint}`) + (marks.length ? `\n${marksText}` : '')} onClick={() => pop.setOpen((o) => !o)}>
        <current.icon className="h-3 w-3 shrink-0 text-ink-faint" />
        {marks.length > 0 && <span className="permission-marks" aria-hidden="true">
          {marks.map((m) => <span key={m.key} className="permission-mark" data-permission-mark={m.key}>{TOGGLE_ICON[m.key](m.on, 'h-3 w-3')}</span>)}
        </span>}
        {!iconOnly && <><span className="min-w-0 truncate text-ink">{current.label}</span>
        <span className="ctl-caret">▾</span></>}
      </button>
      {pop.open && createPortal(
        <div ref={pop.pop} style={pop.style} className="permissions-menu fixed z-[100] p-1" role="menu" aria-label="When the agent asks you" data-asks-menu onKeyDown={(e) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
          const index = controls.indexOf(document.activeElement as HTMLElement);
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? controls.length - 1
            : (index + (e.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
          controls[next]?.focus();
        }}>
          {ASKS_FIRST.map((o) => (
            <button key={o.mode} type="button" role="menuitemradio" aria-checked={o.mode === mode} disabled={sandbox && o.mode !== mode} className="flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-2 disabled:opacity-45 disabled:hover:bg-transparent" onClick={() => void pick(o.mode)}>
              <span className="mt-0.5 flex shrink-0 text-ink-faint" data-mode-icon={o.mode} aria-hidden="true"><o.icon className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-ink">{o.label}</span>
                <span className="block text-2xs text-ink-faint">{sandbox && o.mode === mode ? 'A sandbox always asks.' : o.hint}</span>
              </span>
              {o.mode === mode && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
            </button>
          ))}
          <PermissionRows toggles={toggles} busy={busy} onToggle={(key) => void flip(key)} />
        </div>,
        document.body,
      )}
    </>
  );
}
