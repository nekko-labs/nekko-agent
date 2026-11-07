import React, { useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { saveEmail } from '../components/onboarding/AboutYouSteps.js';
import { validEmail } from '../components/onboarding/aboutYou.js';

/** Settings > General: the name and optional email setup asked for, editable later. */
export function AboutYouSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => unknown }) {
  const [name, setName] = useState(settings.userName ?? '');
  const [email, setEmail] = useState(settings.userEmail ?? '');
  const [note, setNote] = useState('');
  const commitEmail = async () => {
    if (email.trim() === (settings.userEmail ?? '')) return;
    if (email.trim() && !validEmail(email)) { setNote("That doesn't look like an email yet."); return; }
    const error = await saveEmail(email, settings.userName);
    setNote(error ? `Saved here, but it didn't reach Nekko Cloud: ${error}` : email.trim() ? "Saved. We'll send one email to confirm." : 'Removed from this computer.');
  };
  return (
    <section className="card mt-5 p-5">
      <h2 className="font-semibold">About you</h2>
      <label className="mt-3 flex min-h-[40px] items-center justify-between gap-3 text-sm" htmlFor="settings-user-name">
        What Nekko calls you
        <input id="settings-user-name" className="input max-w-[220px] py-1" maxLength={60} placeholder="Your name" value={name}
          onChange={(e) => setName(e.target.value)} onBlur={() => void update({ userName: name.trim() })} />
      </label>
      <label className="mt-2 flex min-h-[40px] items-center justify-between gap-3 text-sm" htmlFor="settings-user-email">
        Email for updates
        <input id="settings-user-email" type="email" className="input max-w-[220px] py-1" placeholder="Optional" value={email}
          onChange={(e) => { setEmail(e.target.value); setNote(''); }} onBlur={() => void commitEmail()}
          onKeyDown={(e) => { if (e.key === 'Enter') void commitEmail(); }} aria-describedby="settings-user-email-note" />
      </label>
      <p id="settings-user-email-note" className="mt-1 text-2xs text-ink-faint" aria-live="polite">
        {note || 'At most one email a month about new features and important fixes. Never sold or shared; unsubscribe from any email.'}
      </p>
    </section>
  );
}
