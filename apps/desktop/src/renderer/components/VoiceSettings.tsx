import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { VoiceStatus, VoiceSettings as Preferences } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { startVoiceCapture } from '../voiceCapture.js';
import { engineRows } from '../voiceEngines.js';
import { StatusDot } from './primitives/index.js';
import { SettingsSection } from './SettingsSection.js';

const VoiceIntro = lazy(() => import('./VoiceIntro.js'));

export function VoiceSettings({ compact = false }: { compact?: boolean }) {
  const settings = useStore(s => s.settings);
  const voice = settings?.voice ?? {};
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState('');
  const [permission, setPermission] = useState('Not checked');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState<number | null>(null);
  const [intro, setIntro] = useState(false);
  const capture = useRef<Awaited<ReturnType<typeof startVoiceCapture>> | null>(null);
  const testGeneration = useRef(0);
  const testStarting = useRef(false);
  const stopTest = () => {
    testGeneration.current++;
    testStarting.current = false;
    capture.current?.abort();
    capture.current = null;
  };
  useEffect(() => {
    let live = true;
    const refresh = () => window.nekko.voiceStatus().then(s => { if (live) setStatus(s); }).catch(e => { if (live) setError(e.message); });
    void refresh(); const timer = setInterval(refresh, 1000);
    return () => { live = false; clearInterval(timer); stopTest(); };
  }, []);
  useEffect(() => { if (voice.enabled === false) { stopTest(); setLevel(null); } }, [voice.enabled]);
  const update = async (patch: Preferences) => {
    if (patch.enabled === false) { stopTest(); setLevel(null); }
    try { const next = await window.nekko.updateSettings({ voice: { ...useStore.getState().settings?.voice, ...patch } }); useStore.setState({ settings: next }); }
    catch (e) { setError((e as Error).message); }
  };
  const act = async (work: () => Promise<unknown>) => { setError(''); try { await work(); setStatus(await window.nekko.voiceStatus()); } catch (e) { setError((e as Error).message); } };
  const test = async () => {
    if (capture.current || testStarting.current) { stopTest(); setLevel(null); return; }
    const generation = ++testGeneration.current;
    const current = () => generation === testGeneration.current;
    testStarting.current = true;
    setError('');
    try {
      const local = await startVoiceCapture({ ...voice, onLevel: n => { if (current()) setLevel(n); }, onSilence: () => { if (current()) { stopTest(); setLevel(null); } } });
      if (!current()) { local.abort(); return; }
      capture.current = local;
      testStarting.current = false;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!current()) return;
      setDevices(devices.filter(d => d.kind === 'audioinput'));
      setPermission('Microphone accessible');
      const status = await window.nekko.voiceStatus();
      if (current()) setStatus(status);
    } catch (e) {
      if (!current()) return;
      stopTest(); setLevel(null);
      setError((e as Error).message);
    }
  };
  const rows = engineRows(status, voice);
  const row = 'flex min-h-(--q-row) items-center justify-between gap-4 py-(--q-inline) text-sm font-medium';
  const field = 'quiet-field max-w-[240px] py-1.5 font-normal';
  const body = <>
    <p className="mt-(--q-tight) text-xs text-ink-faint">Speech models run on this computer; audio is never sent anywhere. Pick the one dictation uses.</p>
    <button type="button" className="mt-(--q-tight) text-xs text-accent hover:underline" onClick={() => setIntro(true)}>Watch how voice works</button>
    {intro && <Suspense fallback={null}><VoiceIntro onClose={() => setIntro(false)} /></Suspense>}
    <ul className="-mx-2 mt-(--q-inline)" aria-label="Speech engines">
      {rows.map(row => <li key={row.id} className="quiet-row min-h-(--q-row) flex-wrap gap-2 px-2!" data-quiet-row>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${row.active ? 'text-accent' : ''}`}>{row.name}{row.active && <span className="ml-2 inline-flex items-center gap-1.5 text-xs font-normal text-ink-soft"><StatusDot tone="success" size={7} />In use</span>}</p>
          <p className="mt-(--q-tight) text-xs text-ink-faint">{row.detail}</p>
          {row.error && <p role="alert" className="mt-(--q-tight) text-xs text-danger-text">{row.error}</p>}
        </div>
        {row.installed && !row.active && <button className="btn btn-ghost py-1 text-xs" onClick={() => void update({ engine: row.id, enabled: true })}>Use</button>}
        {row.active && <button className="btn btn-ghost py-1 text-xs" onClick={() => void update({ enabled: false })}>Turn off</button>}
        {row.action === 'install' && !row.installing && <button className="btn btn-ghost py-1 text-xs" onClick={() => void act(async () => { await window.nekko.voiceInstall(row.id); await update({ engine: row.id, enabled: true }); })}>{row.id === 'apple' ? 'Install language pack' : 'Download'}</button>}
        {row.installing && row.id === 'whisper' && <button className="btn btn-ghost py-1 text-xs" onClick={() => void act(() => window.nekko.voiceCancelInstall())}>Cancel download</button>}
        {row.installing && row.id === 'apple' && <span className="text-xs text-ink-soft">Downloading…</span>}
        {row.action === 'remove' && !row.installing && <button className="btn btn-ghost quiet-row-action py-1 text-xs text-danger-text" onClick={() => { if (window.confirm(row.id === 'apple' ? 'Release the Apple speech language pack? macOS may keep it for other apps.' : 'Remove the downloaded Nekko Voice runtime and model? Custom files are not deleted.')) void act(async () => { if (row.active) await update({ enabled: false }); await window.nekko.voiceUninstall(row.id); }); }}>{row.id === 'apple' ? 'Remove' : 'Uninstall'}</button>}
      </li>)}
      {!rows.length && <li className="px-2 py-(--q-inline) text-xs text-ink-faint">Checking speech engines…</li>}
    </ul>
    {!compact && <div className="mt-(--q-group)">
      {status?.engine === 'whisper' && <><label className={row}>Speech model<input className={field} value={voice.modelPath ?? ''} placeholder="Recommended Nekko Voice model" onChange={e => void update({ modelPath: e.target.value || undefined })} /></label>
      <button className="btn btn-ghost py-1 text-xs" onClick={() => void act(async () => { const files = await window.nekko.openFilesDialog(); if (files[0]) await update({ modelPath: files[0] }); })}>Choose local Whisper .bin model</button>
      <p className="mt-(--q-tight) text-xs text-ink-faint">Only whisper.cpp speech models are compatible. Custom models keep their own license; choose multilingual weights before using other languages.</p>
      <label className={row}>Custom whisper-server path<input className={field} value={voice.runtimePath ?? ''} placeholder="Use downloaded runtime" onChange={e => void update({ runtimePath: e.target.value || undefined })} /></label>
      </>}
      <label className={row}>Recognition language<input className={field} value={voice.language ?? 'en'} onChange={e => void update({ language: e.target.value })} placeholder="en, es, fr, auto (multilingual only)" /></label>
      <label className={row}>Microphone<select className={field} value={voice.deviceId ?? ''} onChange={e => void update({ deviceId: e.target.value || undefined })}><option value="">System default</option>{devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}</select></label>
      <div className="mt-(--q-inline) flex flex-wrap gap-2"><button className="btn btn-ghost py-1 text-xs" onClick={() => void test()}>{level === null ? 'Test microphone / grant access' : 'Stop microphone test'}</button><button className="btn btn-ghost py-1 text-xs" onClick={() => void act(async () => { const p = await window.nekko.voicePermission('settings'); setPermission(`${p.platform}: ${p.status}`); })}>Open microphone privacy settings</button><button className="btn btn-ghost py-1 text-xs" onClick={() => void act(async () => { const p = await window.nekko.voicePermission('status'); setPermission(`${p.platform}: ${p.status}`); })}>Check access</button></div>
      <p className="mt-(--q-inline) text-xs text-ink-faint">{permission}. OS blocks must be changed in system settings. On Linux, check your desktop sound/privacy settings.</p>
      {level !== null && <meter aria-label="Microphone level" className="mt-(--q-inline) w-full" min={0} max={1} value={level} />}
      <label className="mt-(--q-inline) block text-sm font-medium">Speech sensitivity · {voice.sensitivity ?? 60}<input className="mt-(--q-inline) w-full" type="range" min="0" max="100" value={voice.sensitivity ?? 60} onChange={e => void update({ sensitivity: Number(e.target.value) })} /></label>
      <p className="mt-(--q-tight) text-xs text-ink-faint">Higher detects quieter speech but may pick up background noise. This does not change model accuracy.</p>
      <label className={row}>End utterance after silence (ms)<input className={`${field} max-w-[120px]`} type="number" min="300" max="5000" value={voice.silenceMs ?? 1200} onChange={e => void update({ silenceMs: Number(e.target.value) })} /></label>
      <label className={row}>Enable “Nekko…” commands<input type="checkbox" className="h-4 w-4 shrink-0" checked={voice.commandsEnabled !== false} onChange={e => void update({ commandsEnabled: e.target.checked })} /></label>
      {status?.engine === 'whisper' && <><label className={row}>CPU threads<input className={`${field} max-w-[120px]`} type="number" min="1" max="8" value={voice.threads ?? 2} onChange={e => void update({ threads: Number(e.target.value) })} /></label>
      <label className={row}>Unload speech model after idle (seconds)<input className={`${field} max-w-[120px]`} type="number" min="10" max="600" value={voice.idleSeconds ?? 60} onChange={e => void update({ idleSeconds: Number(e.target.value) })} /></label>
      </>}
      <button className="btn btn-ghost mt-(--q-inline) py-1 text-xs" onClick={() => void update({ sensitivity: 60, silenceMs: 1200, threads: 2, idleSeconds: 60 })}>Reset detection settings</button>
    </div>}
    {error && <p role="alert" className="mt-(--q-inline) text-xs text-danger-text">{error}</p>}
  </>;
  return compact
    ? <section className="min-w-0" aria-label="Voice settings"><h2 className="text-sm font-semibold">Dictation</h2>{body}</section>
    : <SettingsSection title="Dictation" aria-label="Voice settings">{body}</SettingsSection>;
}
