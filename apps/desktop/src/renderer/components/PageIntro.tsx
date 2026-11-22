import React, { useId, useState } from 'react';
import { Modal } from './primitives/Modal.js';
import { CloseIcon } from '../icons.js';

/** A page's first-visit guide: what it is, three short steps, and one thing to try. */
export interface PageGuide {
  /** Names the storage key and the `data-<page>-intro` hook journeys use. */
  page: string;
  /** The page's name as the rail shows it ("Skills"). */
  name: string;
  /** Defaults to "Welcome to <name>". */
  title?: string;
  eyebrow: string;
  lead: string;
  steps: [string, string][];
  tryThis: string;
  /** Defaults to "Try this". */
  tryLabel?: string;
  cta: string;
  artwork?: React.ReactNode;
}

export const introKey = (page: string) => `nekko.${page}IntroSeen`;

export function introSeen(page: string): boolean {
  try { return localStorage.getItem(introKey(page)) === '1'; } catch { return false; }
}

export function dismissIntro(page: string): void {
  try { localStorage.setItem(introKey(page), '1'); } catch { /* The guide remains dismissible without browser storage. */ }
}

/** Shown once on the first visit; `open` brings it back from the page's guide button. */
export function usePageIntro(page: string) {
  const [show, setShow] = useState(() => !introSeen(page));
  return { show, open: () => setShow(true), close: () => { dismissIntro(page); setShow(false); } };
}

export function PageIntro({ guide, onClose }: { guide: PageGuide; onClose: () => void }) {
  const title = useId();
  const heading = guide.title ?? `Welcome to ${guide.name}`;
  return <Modal title={heading} labelledBy={title} onClose={onClose} overlayClassName="p-4" className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface shadow-2xl">
    <div {...{ [`data-${guide.page}-intro`]: '' }} className="relative p-5 sm:p-8">
      <button type="button" className="btn-icon absolute right-3 top-3" aria-label={`Close ${guide.name} guide`} onClick={onClose}><CloseIcon className="h-4 w-4" /></button>
      {guide.artwork && <div className="mx-auto max-w-xs">{guide.artwork}</div>}
      <p className="mt-1 text-center text-2xs font-semibold uppercase tracking-widest text-accent">{guide.eyebrow}</p>
      <h2 id={title} className="mt-2 text-center text-2xl font-semibold tracking-tight">{heading}</h2>
      <p className="mx-auto mt-3 max-w-md text-center text-sm text-ink-soft">{guide.lead}</p>
      <ol className="mt-6 grid gap-4 sm:grid-cols-3">
        {guide.steps.map(([step, text], i) => <li key={step}>
          <span className="mb-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent" aria-hidden="true">{i + 1}</span>
          <h3 className="text-sm font-semibold">{step}</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{text}</p>
        </li>)}
      </ol>
      <div className="mt-6 rounded-xl border border-line bg-surface-2 p-3">
        <p className="text-xs font-semibold">{guide.tryLabel ?? 'Try this'}</p>
        <p className="mt-1 text-sm text-ink-soft">{guide.tryThis}</p>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-2xs text-ink-faint">You can reopen this from {guide.name} guide.</p>
        <button type="button" className="btn btn-primary" onClick={onClose}>{guide.cta}</button>
      </div>
    </div>
  </Modal>;
}

/** The page's own button that reopens its guide. */
export function PageGuideButton({ name, onClick }: { name: string; onClick: () => void }) {
  return <button type="button" className="btn btn-ghost shrink-0 px-3 py-1 text-xs" onClick={onClick}>{name} guide</button>;
}

export const SKILLS_GUIDE: PageGuide = {
  page: 'skills',
  name: 'Skills',
  eyebrow: 'Know-how your agents can pick up',
  lead: 'A skill is saved know-how: the steps for one kind of task, written down once so an agent can follow them whenever that task comes up.',
  steps: [
    ['The agent picks it up', 'When what you ask matches a skill, the agent reads it and follows its steps. You do not need to name it.'],
    ['Use one yourself', 'Open a skill to see what it does and how it runs, then press Use in chat to add it to your message.'],
    ['Add more', 'The Marketplace has more skills to add. Skills from other apps on this computer show up here on their own.'],
  ],
  tryThis: 'Open a skill that sounds useful, read its steps, and press Use in chat.',
  cta: 'Explore Skills',
};

export const DESIGN_GUIDE: PageGuide = {
  page: 'design',
  name: 'Design',
  eyebrow: 'Draw it or describe it',
  lead: 'Show the agent what you want, by drawing it or saying it, and it makes a design you can click through.',
  steps: [
    ['Draw or describe', 'Press Sketch to draw boxes and labels, or Generate to say what you want in your own words.'],
    ['Get a design', 'The agent turns it into a working page that lands on this board as a card, saved in your project as a file.'],
    ['Change it', 'Open a card and tell it what to change, as many times as you like. Earlier versions are kept, so you can go back.'],
  ],
  tryThis: 'Press Generate and ask for “a landing page for a neighborhood bakery”.',
  cta: 'Start designing',
};

export const CONNECTORS_GUIDE: PageGuide = {
  page: 'connectors',
  name: 'Connectors',
  eyebrow: 'Bring your other apps in',
  lead: 'Connect the apps where your work lives, so an agent can read your issues, messages and documents when you ask it to.',
  steps: [
    ['Connect an app', 'Pick an app and add its sign-in details. They stay on this computer and are checked when you connect.'],
    ['Ask about it', 'In a chat, ask about what is in that app. The agent pulls in what it needs to answer.'],
    ['Chat from a messaging app', 'Messaging channels let you talk to an agent from an app like Telegram. Only chats you allow can reach it.'],
  ],
  tryThis: 'Connect one app you use every day, then ask a chat to summarize what changed there this week.',
  cta: 'Explore Connectors',
};

export const MEMORY_GUIDE: PageGuide = {
  page: 'memory',
  name: 'Memory',
  eyebrow: 'What your agents remember',
  lead: 'Memory is a set of short notes your agents read before they start, so you do not have to repeat yourself.',
  steps: [
    ['Notes for every chat', 'Global notes are read by every chat. Workspace notes are read only by chats in that workspace.'],
    ['Agents add to it', 'When an agent learns something lasting about you, it saves a note and shows a card in the chat.'],
    ['You stay in charge', 'Open any note to change or delete it, or press + to write your own. Private chats read none of it.'],
  ],
  tryThis: 'Press + and write one note about how you like answers, for example “Keep replies short”.',
  cta: 'Explore Memory',
};
