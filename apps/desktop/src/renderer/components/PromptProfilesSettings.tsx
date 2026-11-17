import React, { useEffect, useState } from 'react';
import type { AppSettings, PromptProfileName } from '@nekko-agent/shared';
import { SettingRow, SettingsSection } from './SettingsSection.js';
import { useStore } from '../store.js';

const PROFILES: { id: PromptProfileName; label: string; about: string }[] = [
  { id: 'small', label: 'Small', about: 'Short and concrete, for small local models and short context windows.' },
  { id: 'medium', label: 'Medium', about: 'The working rules, with the pull request, CI and verification detail shortened.' },
  { id: 'large', label: 'Large', about: 'Every rule in full. What every model gets until you change it.' },
];

type Group = 'models' | 'providers';
type Choice = PromptProfileName | 'auto';

/** The `promptProfiles` setting with one override changed; `auto` removes it. */
export function withProfile(settings: AppSettings, group: Group, key: string, value: Choice): NonNullable<AppSettings['promptProfiles']> {
  const current = settings.promptProfiles ?? {};
  const next = { ...(current[group] ?? {}) };
  if (value === 'auto') delete next[key]; else next[key] = value;
  return { ...current, [group]: next };
}

function ProfileSelect({ id, label, value, onChange }: { id: string; label: string; value: Choice; onChange: (v: Choice) => void }) {
  return (
    <select id={id} aria-label={label} className="quiet-field w-[180px] py-1" value={value} onChange={(e) => onChange(e.target.value as Choice)}>
      <option value="auto">Automatic</option>
      {PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select>
  );
}

/** Which system prompt each model gets: the built-in text of every profile, a default per provider and an override per model. */
export function PromptProfilesSettings({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const [tab, setTab] = useState<PromptProfileName>('large');
  const [texts, setTexts] = useState<Record<PromptProfileName, string> | null>(null);
  const models = useStore((s) => s.models);
  const activeProviderId = useStore((s) => s.activeProviderId);
  useEffect(() => { void window.nekko.promptProfileTexts().then(setTexts).catch(() => setTexts(null)); }, []);
  const pick = (group: Group, key: string, value: Choice) => update({ promptProfiles: withProfile(settings, group, key, value) });
  const overrides = settings.promptProfiles?.models ?? {};
  const [chosen, setChosen] = useState('');
  const keys = new Set([...Object.keys(overrides), ...(chosen ? [chosen] : [])]);
  const addable = models.filter((m) => !(`${m.providerId}::${m.id}` in overrides));
  const active = PROFILES.find((p) => p.id === tab)!;
  return (
    <SettingsSection id="prompt-profiles" title="System prompt size" help="Nekko can give small models a shorter built-in prompt. Your own System prompt above is added to every profile.">
      <SettingRow
        title="Choose automatically"
        detail="Small for small local models and short windows, Large for big ones, Medium otherwise. Off gives every model the Large prompt."
        htmlFor="prompt-profiles-auto"
        control={<input id="prompt-profiles-auto" type="checkbox" checked={settings.promptProfiles?.auto === true} onChange={(e) => update({ promptProfiles: { ...settings.promptProfiles, auto: e.target.checked } })} />}
      />
      <div role="tablist" aria-label="Built-in prompt" className="mt-(--q-group) flex gap-4">
        {PROFILES.map((p) => (
          <button key={p.id} type="button" role="tab" aria-selected={tab === p.id} className={`text-sm font-medium ${tab === p.id ? 'text-accent' : 'text-ink-soft'}`} onClick={() => setTab(p.id)}>{p.label}</button>
        ))}
      </div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">{active.about}</p>
      <pre role="tabpanel" aria-label={`${active.label} built-in prompt`} className="quiet-field mt-(--q-inline) max-h-[240px] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed" tabIndex={0}>{texts?.[tab] ?? 'Not available right now.'}</pre>
      <div className="mt-(--q-group) quiet-group-label">Default for a provider</div>
      {settings.providers.map((p) => (
        <SettingRow key={p.id} title={p.label} htmlFor={`prompt-profile-provider-${p.id}`} control={<ProfileSelect id={`prompt-profile-provider-${p.id}`} label={`${p.label} default`} value={settings.promptProfiles?.providers?.[p.id] ?? 'auto'} onChange={(v) => pick('providers', p.id, v)} />} />
      ))}
      <div className="mt-(--q-group) quiet-group-label">Override for a model</div>
      {[...keys].map((key) => (
        <SettingRow key={key} title={key.split('::')[1] ?? key} detail={settings.providers.find((p) => p.id === key.split('::')[0])?.label} htmlFor={`prompt-profile-model-${key}`} control={<ProfileSelect id={`prompt-profile-model-${key}`} label={`${key} override`} value={overrides[key] ?? 'auto'} onChange={(v) => pick('models', key, v)} />} />
      ))}
      {addable.length > 0 && (
        <SettingRow title="Add a model" detail="From the provider you are using now." htmlFor="prompt-profile-add" control={
          <select id="prompt-profile-add" className="quiet-field w-[180px] py-1" value="" onChange={(e) => { if (e.target.value) { setChosen(e.target.value); pick('models', e.target.value, 'large'); } }}>
            <option value="">Choose...</option>
            {addable.map((m) => <option key={`${m.providerId || activeProviderId}::${m.id}`} value={`${m.providerId || activeProviderId}::${m.id}`}>{m.name}</option>)}
          </select>
        } />
      )}
    </SettingsSection>
  );
}
