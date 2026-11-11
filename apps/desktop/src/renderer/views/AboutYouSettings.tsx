import React, { useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { saveEmail } from '../components/onboarding/AboutYouSteps.js';
import { validEmail } from '../components/onboarding/aboutYou.js';
import { SettingRow, SettingsSection } from '../components/SettingsSection.js';

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
    <SettingsSection title="About you">
      <SettingRow title="What Nekko calls you" htmlFor="settings-user-name" className="mt-(--q-inline)" control={
        <input id="settings-user-name" className="quiet-field max-w-[220px] py-1.5" maxLength={60} placeholder="Your name" value={name}
          onChange={(e) => setName(e.target.value)} onBlur={() => void update({ userName: name.trim() })} />
      } />
      <SettingRow title="Email for updates" htmlFor="settings-user-email" detailId="settings-user-email-note"
        detail={<span aria-live="polite">{note || 'At most one email a month about new features and important fixes. Never sold or shared; unsubscribe from any email.'}</span>}
        control={
          <input id="settings-user-email" type="email" className="quiet-field max-w-[220px] py-1.5" placeholder="Optional" value={email}
            onChange={(e) => { setEmail(e.target.value); setNote(''); }} onBlur={() => void commitEmail()}
            onKeyDown={(e) => { if (e.key === 'Enter') void commitEmail(); }} aria-describedby="settings-user-email-note" />
        } />
    </SettingsSection>
  );
}
