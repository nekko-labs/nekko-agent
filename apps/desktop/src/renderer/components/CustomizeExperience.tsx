import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { saveSettings, openSettingsGroup } from '../settingsIndex.js';
import { Modal } from './primitives/Modal.js';
import { ModeSwitch } from './ModeViews.js';
import { ThemePresetPicker } from './ThemePresetPicker.js';
import { SimpleModeSettings } from './SimpleModeSettings.js';
import { CloseIcon } from '../icons.js';
import { readTone, withTone, TONES } from '../experienceTone.js';
import './customizeExperience.css';

const Connectors = lazy(() => import('../views/ConnectorsView.js').then(m => ({ default: m.ConnectorsView })));
const Skills = lazy(() => import('../views/SkillsView.js').then(m => ({ default: m.SkillsView })));
const OPEN = 'nekko:customize';
export function openCustomize() { window.dispatchEvent(new Event(OPEN)); }

/** One destination; catalog tabs reuse their existing install and permission flows. */
export function CustomizeExperience() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('Experience');
  useEffect(() => {
    const show = () => { setTab('Experience'); setOpen(true); };
    window.addEventListener(OPEN, show);
    return () => window.removeEventListener(OPEN, show);
  }, []);
  if (!open) return null;
  const settings = (group: string) => { setOpen(false); openSettingsGroup(group); };
  return <Modal title="Customize" onClose={() => setOpen(false)} className="customize-experience">
    <header className="flex items-center justify-between px-6 pt-5">
      <h1 className="text-xl font-semibold">Customize</h1>
      <button className="btn btn-ghost" aria-label="Close Customize" onClick={() => setOpen(false)}><CloseIcon className="h-4 w-4" /></button>
    </header>
    <div role="tablist" aria-label="Customize your experience" className="customize-tabs">
      {['Experience', 'Connectors', 'Skills'].map((name, index, names) => <button key={name} id={`customize-${name}`} role="tab" aria-selected={tab === name} aria-controls="customize-panel" tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? names.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length;
        setTab(names[next]); document.getElementById(`customize-${names[next]}`)?.focus();
      }}>{name}</button>)}
    </div>
    <div id="customize-panel" role="tabpanel" aria-labelledby={`customize-${tab}`} className="customize-panel">
      <Suspense fallback={<p className="p-6" role="status">Loading…</p>}>
        {tab === 'Experience' && <ExperienceControls onSettings={settings} />}
        {tab === 'Connectors' && <Connectors />}
        {tab === 'Skills' && <Skills />}
      </Suspense>
    </div>
  </Modal>;
}

export function ExperienceControls({ onSettings }: { onSettings: (group: string) => void }) {
  const settings = useStore(s => s.settings);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  if (!settings) return <p role="status">Loading preferences…</p>;
  const tone = readTone(settings.systemInstructions ?? '');
  return <div className="customize-content">
    <h2 className="text-2xl font-medium">Make Nekko work your way</h2>
    <p className="mt-2 text-sm text-ink-soft">Choose what you see and how your agents work. The same capabilities, with the details you want.</p>
    <section className="customize-section">
      <h3>Agent output</h3>
      <p>Simple folds working steps away. Detailed shows tools, reasoning when available, and reply statistics. This changes the view, not what the agent is allowed to do.</p>
      <ModeSwitch labels />
    </section>
    <section className="customize-section">
      <h3>Tone</h3>
      <p>A communication preference, sent with your existing standing instructions. Safety rules and permissions stay the same.</p>
      <select aria-label="Agent tone" className="input mt-3" value={tone} disabled={saving} onChange={async e => {
        const nextTone = e.target.value as keyof typeof TONES;
        setSaving(true); setError('');
        try { await saveSettings({ systemInstructions: withTone(settings.systemInstructions ?? '', nextTone) }); }
        catch (e) { setError(e instanceof Error ? e.message : 'Could not save tone. Try again.'); }
        finally { setSaving(false); }
      }}>{Object.keys(TONES).map(name => <option key={name}>{name}</option>)}</select>
      {error && <p role="alert" className="text-danger">{error}</p>}
    </section>
    <section className="customize-section">
      <h3>Visual experience</h3>
      <ThemePresetPicker settings={settings} update={async patch => { await saveSettings(patch); useStore.getState().applyTheme(); }} showLabel={false} />
      <button className="btn btn-ghost mt-3" onClick={() => onSettings('accessibility')}>Text size and accessibility →</button>
    </section>
    <section className="customize-section">
      <h3>How agents work</h3>
      <p>Choose when agents ask first, how they delegate, and your standing instructions. Permission changes use the existing confirmation flow.</p>
      <button className="btn btn-outline mt-3" onClick={() => onSettings('agents')}>Agent behavior →</button>
      <button className="btn btn-ghost mt-3" onClick={() => onSettings('general')}>Standing instructions →</button>
    </section>
    <section className="customize-section">
      <h3>Monitors and visible controls</h3>
      <p>The Monitors panel’s Configure menu chooses which monitors appear in both modes. Simple and Detailed remember whether the panel is open separately.</p>
      <SimpleModeSettings />
    </section>
  </div>;
}
