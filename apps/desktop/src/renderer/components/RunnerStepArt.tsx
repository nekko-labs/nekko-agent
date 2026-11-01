import React from 'react';

/** The two step illustrations, in theme tokens so they follow light and dark. */
export const GithubStepArt = () => (
  <svg role="img" aria-label="A repository plugged into a laptop" viewBox="0 0 260 120">
    <rect x="12" y="16" width="84" height="88" rx="13" fill="var(--surface)" stroke="var(--line)" strokeWidth="1.5" />
    <g fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"><path d="M36 36v48" /><path d="M36 66c0-12 30-6 30-20" /></g>
    <g fill="var(--surface)" stroke="var(--accent)" strokeWidth="3"><circle cx="36" cy="36" r="6.5" /><circle cx="36" cy="84" r="6.5" /><circle cx="66" cy="40" r="6.5" /></g>
    <path d="M96 60h18M150 60h16" stroke="var(--ink-faint)" strokeWidth="3" strokeLinecap="round" />
    <rect x="113" y="47" width="22" height="26" rx="6" fill="var(--accent)" />
    <path d="M135 54h8M135 66h8" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
    <circle cx="150" cy="60" r="4.5" fill="var(--accent)" />
    <rect x="166" y="26" width="76" height="52" rx="7" fill="var(--surface)" stroke="var(--ink-soft)" strokeWidth="2.5" />
    <path d="M155 84h98l-5 9a4 4 0 0 1-3.5 2h-81a4 4 0 0 1-3.5-2z" fill="var(--surface)" stroke="var(--ink-soft)" strokeWidth="2.5" strokeLinejoin="round" />
    <circle cx="204" cy="52" r="13" fill="var(--accent-soft)" />
    <path d="m198 52 4.5 4.5 8-9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const MacStepArt = () => (
  <svg role="img" aria-label="macOS downloading into a protected VM on a laptop" viewBox="0 0 260 120">
    <rect x="62" y="12" width="136" height="84" rx="9" fill="var(--surface)" stroke="var(--ink-soft)" strokeWidth="2.5" />
    <path d="M46 102h168l-6 10a4 4 0 0 1-3.5 2h-149a4 4 0 0 1-3.5-2z" fill="var(--surface)" stroke="var(--ink-soft)" strokeWidth="2.5" strokeLinejoin="round" />
    <rect x="80" y="25" width="100" height="59" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
    <path d="M80 39h100" stroke="var(--accent)" strokeWidth="1.5" />
    <g fill="var(--accent)"><circle cx="89" cy="32" r="2" /><circle cx="96" cy="32" r="2" /><circle cx="103" cy="32" r="2" /></g>
    <path d="M130 45c5 3.2 9 4 14 4 0 12-5 20-14 25-9-5-14-13-14-25 5 0 9-.8 14-4z" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
    <path d="m124 60 4.5 4.5 7.5-8.5" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M216 49c-6 12-16 18-30 19" fill="none" stroke="var(--ink-faint)" strokeWidth="2.5" strokeDasharray="1 7" strokeLinecap="round" />
    <circle cx="222" cy="30" r="19" fill="var(--accent)" />
    <path d="M222 20v18m-7.5-7 7.5 7.5 7.5-7.5" fill="none" stroke="var(--on-accent)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
