import React from 'react';
import { PageIntro, dismissIntro, introKey, introSeen, type PageGuide } from './PageIntro.js';

export const LIBRARY_INTRO_KEY = introKey('library');
export const libraryIntroSeen = () => introSeen('library');
export const dismissLibraryIntro = () => dismissIntro('library');

/** Original, static artwork: no network, file reads, motion or preview permissions. */
export function LibraryArtwork() {
  return <svg viewBox="0 0 440 220" fill="none" aria-hidden="true" className="w-full">
    <rect x="28" y="28" width="384" height="168" rx="28" fill="var(--accent-soft)" />
    <path d="M66 176H374" stroke="var(--line)" strokeWidth="2" />
    <g transform="rotate(-10 140 110)">
      <rect x="82" y="51" width="115" height="132" rx="12" fill="var(--surface-2)" stroke="var(--line)" />
      <rect x="96" y="68" width="87" height="56" rx="6" fill="var(--accent-soft)" />
      <path d="M99 116L123 91L144 109L158 97L182 120" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="163" cy="82" r="6" fill="var(--accent)" />
      <path d="M98 140H173M98 151H151" stroke="var(--ink-faint)" strokeWidth="3" strokeLinecap="round" />
    </g>
    <g transform="rotate(9 303 111)">
      <rect x="256" y="51" width="104" height="132" rx="12" fill="var(--surface-2)" stroke="var(--line)" />
      <rect x="272" y="113" width="14" height="34" rx="3" fill="var(--accent)" opacity=".45" />
      <rect x="293" y="92" width="14" height="55" rx="3" fill="var(--accent)" opacity=".7" />
      <rect x="314" y="75" width="14" height="72" rx="3" fill="var(--accent)" />
      <path d="M272 161H327" stroke="var(--ink-faint)" strokeWidth="3" strokeLinecap="round" />
    </g>
    <rect x="155" y="25" width="135" height="171" rx="12" fill="var(--win)" stroke="var(--line)" />
    <rect x="171" y="43" width="36" height="7" rx="3" fill="var(--accent)" />
    <path d="M172 68H268M172 80H248M172 92H261" stroke="var(--ink-faint)" strokeWidth="3" strokeLinecap="round" />
    <rect x="171" y="109" width="102" height="48" rx="6" fill="var(--accent-soft)" />
    <path d="M180 147L201 135L219 140L244 120L263 126" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M172 173H237" stroke="var(--ink-faint)" strokeWidth="3" strokeLinecap="round" />
    <circle cx="290" cy="179" r="19" fill="var(--accent)" />
    <path d="M282 179L288 185L299 173" stroke="var(--win)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export const LIBRARY_GUIDE: PageGuide = {
  page: 'library',
  name: 'Library',
  title: 'Welcome to your Library',
  eyebrow: 'Made in a chat. Found here.',
  lead: 'A home for the reports, pages, designs and other files your agents create, without digging through old chats.',
  steps: [
    ['Make something', 'Ask an agent for a report, a page or a diagram. Files it creates or links in a chat appear here automatically.'],
    ['Find it again', 'Browse by kind or filter by name and chat. Pick a file to preview it, or open its original chat to keep working.'],
    ['Keep it yours', 'Files stay in their original folders. Open a file in its usual app to save a copy or share it. Nothing is published automatically.'],
  ],
  tryLabel: 'Try this in a chat',
  tryThis: '“Create a one-page report and link the file in your reply.”',
  cta: 'Explore Library',
  artwork: <LibraryArtwork />,
};

export function LibraryIntro({ onClose }: { onClose: () => void }) {
  return <PageIntro guide={LIBRARY_GUIDE} onClose={onClose} />;
}
