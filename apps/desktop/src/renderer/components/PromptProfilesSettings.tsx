import React, { useEffect, useState } from 'react';
import type { AppSettings, PromptProfileName } from '@nekko-agent/shared';
import { SettingRow, SettingsLabel, SettingsSection } from './SettingsSection.js';
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

/** Saving an empty draft removes only this model's instructions. */
export function withModelInstructions(settings: AppSettings, key: string, value: string): NonNullable<AppSettings['promptProfiles']> {
  const current = settings.promptProfiles ?? {};
  const next = { ...current.modelInstructions };
  const text = value.trim();
  if (text) next[key] = text; else delete next[key];
  return { ...current, modelInstructions: next };
}

function modelRoute(key: string): [providerId: string, modelId: string] {
  const separator = key.indexOf('::');
  return separator < 0 ? ['', key] : [key.slice(0, separator), key.slice(separator + 2)];
}

function ModelInstructionsEditor({ value, save }: { value: string; save: (text: string) => void }) {
  const [draft, setDraft] = useState<string>();
  const text = draft ?? value;
  return (
    <div className="mt-(--q-inline) grid gap-2">
      <label htmlFor="prompt-profile-instructions-text" className="text-sm font-medium">Additional instructions</label>
      <p id="prompt-profile-instructions-help" className="text-xs text-ink-faint">Added only for this provider and model. Clear and save to remove.</p>
      <textarea id="prompt-profile-instructions-text" aria-describedby="prompt-profile-instructions-help" className="quiet-field w-full resize-y" rows={4} value={text} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className="btn btn-ghost justify-self-start" disabled={text.trim() === value.trim()} onClick={() => save(text)}>Save instructions</button>
    </div>
  );
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
  const [instructionModel, setInstructionModel] = useState('');
  const keys = new Set([...Object.keys(overrides), ...(chosen ? [chosen] : [])]);
  const catalogKeys = models.flatMap((m) => {
    const id = m.providerId;
    return id && !id.includes('::') && !id.endsWith(':') && m.id ? [`${id}::${m.id}`] : [];
  });
  const addable = models.filter((m) => !(`${m.providerId}::${m.id}` in overrides));
  const instructions = settings.promptProfiles?.modelInstructions ?? {};
  const providerFor = (id: string) => settings.providers.find((p) => p.id === id);
  const instructionKeys = [...new Set([...Object.keys(instructions), ...keys, ...catalogKeys, instructionModel])].filter((key) => {
    const [providerId, modelId] = modelRoute(key);
    return providerId && modelId && providerFor(providerId)?.kind !== 'claude-code';
  });
  const selected = instructionKeys.includes(instructionModel) ? instructionModel : '';
  const savedText = typeof instructions[selected] === 'string' ? instructions[selected] : '';
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
        <SettingRow key={key} title={modelRoute(key)[1]} detail={providerFor(modelRoute(key)[0])?.label} htmlFor={`prompt-profile-model-${key}`} control={<ProfileSelect id={`prompt-profile-model-${key}`} label={`${key} override`} value={overrides[key] ?? 'auto'} onChange={(v) => pick('models', key, v)} />} />
      ))}
      {addable.length > 0 && (
        <SettingRow title="Add a model" detail="From the provider you are using now." htmlFor="prompt-profile-add" control={
          <select id="prompt-profile-add" className="quiet-field w-[180px] py-1" value="" onChange={(e) => { if (e.target.value) { setChosen(e.target.value); pick('models', e.target.value, 'large'); } }}>
            <option value="">Choose...</option>
            {addable.map((m) => <option key={`${m.providerId || activeProviderId}::${m.id}`} value={`${m.providerId || activeProviderId}::${m.id}`}>{m.name}</option>)}
          </select>
        } />
      )}
      {instructionKeys.length > 0 && <>
        <SettingsLabel>Instructions for a model</SettingsLabel>
        <SettingRow title="Model" htmlFor="prompt-profile-instructions-model" control={
          <select id="prompt-profile-instructions-model" className="quiet-field w-[180px] py-1" value={selected} onChange={(e) => setInstructionModel(e.target.value)}>
            <option value="">Choose...</option>
            {instructionKeys.map((key) => {
              const [providerId, modelId] = modelRoute(key);
              return <option key={key} value={key}>{modelId} · {providerFor(providerId)?.label ?? providerId}</option>;
            })}
          </select>
        } />
        {selected && <ModelInstructionsEditor key={selected} value={savedText} save={(text) => update({ promptProfiles: withModelInstructions(settings, selected, text) })} />}
      </>}
    </SettingsSection>
  );
}
