import React, { useState } from 'react';
import type { AppSettings, WorkProfile } from '@nekko-agent/shared';
import { useCloudAccountEmail } from '../components/cloud/useCloudAccountEmail.js';
import { saveEmail } from '../components/onboarding/AboutYouSteps.js';
import { PROFILES, validEmail } from '../components/onboarding/aboutYou.js';
import { SettingRow, SettingsSection } from '../components/SettingsSection.js';

/**
 * Settings > Profile: who you are to Nekko. The name and optional email setup
 * asked for, what you mostly do, and the About you note sent with each chat.
 */
export function AboutYouSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => unknown }) {
  const [name, setName] = useState(settings.userName ?? '');
  const cloudEmail = useCloudAccountEmail();
  const savedEmail = settings.userEmail?.trim() ?? '';
  const defaultEmail = savedEmail || cloudEmail;
  const [emailDraft, setEmailDraft] = useState<string>();
  const email = emailDraft ?? defaultEmail;
  const [note, setNote] = useState('');
  const commitEmail = async () => {
    if (emailDraft === undefined) return;
    const clean = emailDraft.trim();
    if (clean === defaultEmail || clean === savedEmail) { setEmailDraft(undefined); return; }
    if (clean && !validEmail(clean)) { setNote("That doesn't look like an email yet."); return; }
    const error = await saveEmail(clean, settings.userName);
    setEmailDraft(draft => draft === emailDraft ? undefined : draft);
    setNote(error ? `Saved here, but it didn't reach Nekko Cloud: ${error}` : clean ? "Saved. We'll send one email to confirm." : 'Saved address removed.');
  };
  return (
    <SettingsSection id="about-you" title="About you">
      <SettingRow title="What Nekko calls you" htmlFor="settings-user-name" className="mt-(--q-inline)" control={
        <input id="settings-user-name" className="quiet-field max-w-[220px] py-1.5" maxLength={60} placeholder="Your name" value={name}
          onChange={(e) => setName(e.target.value)} onBlur={() => void update({ userName: name.trim() })} />
      } />
      <SettingRow title="Email for updates" htmlFor="settings-user-email" detailId="settings-user-email-note"
        detail={<span aria-live="polite">{note || (!savedEmail && cloudEmail && emailDraft === undefined ? 'From Nekko Cloud. Signing in doesn’t sign you up for updates.' : 'At most one email a month about new features and important fixes. Never sold or shared; unsubscribe from any email.')}</span>}
        control={
          <input id="settings-user-email" type="email" className="quiet-field max-w-[220px] py-1.5" placeholder="Optional" value={email}
            onChange={(e) => { setEmailDraft(e.target.value); setNote(''); }} onBlur={() => void commitEmail()}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} aria-describedby="settings-user-email-note" />
        } />
      <SettingRow title="What you mostly do" htmlFor="settings-work-profile" control={
        <select id="settings-work-profile" className="quiet-field w-[220px] py-1" value={settings.workProfile ?? ''}
          onChange={(e) => void update({ workProfile: (e.target.value || undefined) as WorkProfile | undefined })}>
          <option value="">Not chosen</option>
          {PROFILES.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      } />
      <label className="mt-(--q-group) block">
        <span className="block text-sm font-medium">More about you</span>
        <textarea key={settings.aboutUser ?? ''} aria-label="About you" className="quiet-field mt-(--q-inline) min-h-[100px] resize-y text-xs leading-relaxed"
          placeholder="Your role, experience, goals and how you like answers. Sent to the chosen model with every chat, so leave secrets out."
          defaultValue={settings.aboutUser ?? ''} onBlur={(e) => { if (e.target.value !== (settings.aboutUser ?? '')) void update({ aboutUser: e.target.value }); }} />
      </label>
    </SettingsSection>
  );
}
