import React, { useEffect, useState } from 'react';
import type { AppSettings, WorkProfile } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { CapIcon, CheckIcon, CodeIcon, CompassIcon, DocTextIcon, PencilIcon, ShieldCheckIcon, SlidersIcon } from '../../icons.js';
import { PROFILES, validEmail } from './aboutYou.js';

type CommitRef = React.MutableRefObject<(() => Promise<void | boolean>) | null>;

async function save(patch: Partial<AppSettings>) {
  const next = await window.nekko.updateSettings(patch);
  useStore.setState({ settings: next });
}

/**
 * Saves the email and joins Nekko Cloud's update list once per new address.
 * The address stays saved here even when Nekko Cloud can't be reached; the
 * returned message says so.
 */
export async function saveEmail(email: string, name?: string): Promise<string | null> {
  const clean = email.trim();
  const before = useStore.getState().settings?.userEmail ?? '';
  await save({ userEmail: clean });
  if (!clean || clean.toLowerCase() === before.toLowerCase()) return null;
  try {
    await window.nekko.updatesJoin(clean, name?.trim() || undefined);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The newest pixel Nekko (the peeking cat's face, no mouth), whole and drawn in the theme's own ink. */
export function SetupNekko({ size = 72, happy = false, className = '' }: { size?: number; happy?: boolean; className?: string }) {
  return (
    <svg className={`setup-nekko ${className}`} viewBox="0 0 32 28" width={size} height={size * 0.875} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
      <g fill="var(--ink)">
        {happy
          ? <path d="M10 17V15H11V14H13V15H14V17H13V16H11V17Z M19 17V15H20V14H22V15H23V17H22V16H20V17Z" />
          : <path className="setup-nekko-eyes" d="M11 15H13V18H11Z M20 15H22V18H20Z" />}
      </g>
    </svg>
  );
}

function Heading({ title, sub, htmlFor }: { title: string; sub: string; htmlFor?: string }) {
  return (
    <>
      <h1 className="mt-5 text-center text-2xl font-semibold tracking-tight">{htmlFor ? <label htmlFor={htmlFor}>{title}</label> : title}</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-ink-soft">{sub}</p>
    </>
  );
}

/** "What should I call you?" Saved on Next; the chat welcome and greetings use it. */
export function NameStep({ commitRef, onSubmit }: { commitRef: CommitRef; onSubmit: () => void }) {
  const [name, setName] = useState(() => useStore.getState().settings?.userName ?? '');
  const trimmed = name.trim();
  useEffect(() => {
    commitRef.current = () => save({ userName: trimmed.slice(0, 60) });
    return () => { commitRef.current = null; };
  }, [commitRef, trimmed]);
  return (
    <div className="flex w-full flex-col items-center">
      <SetupNekko size={80} happy={!!trimmed} />
      <Heading title="What should I call you?" sub="Your name, a nickname, anything you like." htmlFor="setup-name" />
      <input
        id="setup-name"
        className="input mt-7 h-14 w-full max-w-sm text-center text-xl font-medium"
        autoComplete="given-name"
        placeholder="Your name"
        maxLength={60}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
        autoFocus
      />
      <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-surface-2 px-4 py-2 text-sm text-ink-soft">
        <SetupNekko size={16} />
        <span>Hi {trimmed || 'there'}, what should we work on?</span>
      </div>
    </div>
  );
}

/**
 * Optional email for update mail. Nothing leaves this computer unless a valid
 * address is given and Next is pressed; No thanks (skip) sends nothing.
 */
export function EmailStep({ commitRef, onSubmit }: { commitRef: CommitRef; onSubmit: () => void }) {
  const settings = useStore((s) => s.settings);
  const [email, setEmail] = useState(() => settings?.userEmail ?? '');
  const [tried, setTried] = useState(false);
  const bad = !!email.trim() && !validEmail(email);
  const name = settings?.userName?.trim();
  useEffect(() => {
    commitRef.current = async () => {
      if (bad) { setTried(true); return false; }
      const error = await saveEmail(email, settings?.userName);
      if (error) useStore.getState().pushToast('error', `Saved your email here, but it didn't reach Nekko Cloud: ${error}`);
    };
    return () => { commitRef.current = null; };
  }, [commitRef, email, bad, settings?.userName]);
  return (
    <div className="flex w-full flex-col items-center">
      <SetupNekko size={80} />
      <Heading title={name ? `What's your email, ${name}?` : "What's your email?"} sub="Optional. Only if you'd like to hear about big updates." htmlFor="setup-email" />
      <input
        id="setup-email"
        type="email"
        className="input mt-7 h-12 w-full max-w-sm text-center text-base"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        aria-invalid={tried && bad}
        aria-describedby="setup-email-note setup-email-error"
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => setTried(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
        autoFocus
      />
      <p id="setup-email-error" role="alert" className="mt-2 h-5 text-xs text-danger">
        {tried && bad ? "That doesn't look like an email yet." : ''}
      </p>
      <div id="setup-email-note" className="mt-3 flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-accent" style={{ background: 'var(--accent-soft)' }}><ShieldCheckIcon className="h-5 w-5" /></span>
        <span>
          <span className="block text-sm font-semibold">We never sell, share or spam.</span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-soft">
            At most one email a month about new features and important fixes. We'll send one email to confirm, and you can unsubscribe in one click.{' '}
            <a className="underline" href="https://nekkoagent.com/privacy.html" target="_blank" rel="noreferrer">Privacy policy</a>
          </span>
        </span>
      </div>
    </div>
  );
}

const PROFILE_ICONS: Record<WorkProfile, (p: { className?: string }) => React.ReactElement> = {
  developer: CodeIcon, designer: PencilIcon, writer: DocTextIcon, business: SlidersIcon, student: CapIcon, exploring: CompassIcon,
};

/** "What do you mostly do?" Six cards; the pick only seeds the next step's detail level. */
export function WorkStep({ commitRef }: { commitRef: CommitRef }) {
  const [picked, setPicked] = useState<WorkProfile | undefined>(() => useStore.getState().settings?.workProfile);
  const name = useStore((s) => s.settings?.userName?.trim());
  useEffect(() => {
    commitRef.current = picked ? () => save({ workProfile: picked }) : null;
    return () => { commitRef.current = null; };
  }, [commitRef, picked]);
  return (
    <div className="w-full">
      <h1 id="setup-work" className="text-center text-2xl font-semibold tracking-tight">What do you mostly do{name ? `, ${name}` : ''}?</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-ink-soft">Pick the closest. It only sets where I start, and you can change anything later.</p>
      <div role="radiogroup" aria-labelledby="setup-work" className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {PROFILES.map((p) => {
          const on = p.id === picked;
          const Icon = PROFILE_ICONS[p.id];
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(p.id)}
              className={`setup-card flex flex-col items-start rounded-2xl border p-4 text-left ${on ? 'is-on border-accent' : 'border-line bg-surface hover:bg-surface-2'}`}
            >
              <span className="flex w-full items-center justify-between">
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${on ? 'bg-accent text-on-accent' : 'bg-surface-2'}`}><Icon className="h-5 w-5" /></span>
                {on && <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-on-accent"><CheckIcon className="h-3 w-3" /></span>}
              </span>
              <span className="mt-3 text-sm font-semibold">{p.title}</span>
              <span className="mt-0.5 text-xs text-ink-soft">{p.desc}</span>
              <span className="mt-2 font-mono text-2xs text-ink-faint">Starts {p.level[0].toUpperCase() + p.level.slice(1)}{p.level === 'detailed' ? ' · Monitors on' : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
