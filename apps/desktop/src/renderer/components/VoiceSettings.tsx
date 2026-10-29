import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { VoiceStatus, VoiceSettings as Preferences } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { startVoiceCapture } from '../voiceCapture.js';
import { engineRows } from '../voiceEngines.js';

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
  useEffect(() => {
    let live = true;
    const refresh = () => window.nekko.voiceStatus().then(s => { if (live) setStatus(s); }).catch(e => { if (live) setError(e.message); });
    void refresh(); const timer = setInterval(refresh, 1000);
    return () => { live = false; clearInterval(timer); capture.current?.abort(); };
  }, []);
  const update = async (patch: Preferences) => {
    try { const next = await window.nekko.updateSettings({ voice: { ...useStore.getState().settings?.voice, ...patch } }); useStore.setState({ settings: next }); if (patch.enabled === false) { capture.current?.abort(); capture.current = null; setLevel(null); } }
    catch (e) { setError((e as Error).message); }
  };
  const act = async (work: () => Promise<unknown>) => { setError(''); try { await work(); setStatus(await window.nekko.voiceStatus()); } catch (e) { setError((e as Error).message); } };
  const test = async () => {
    if (capture.current) { capture.current.abort(); capture.current = null; setLevel(null); return; }
    await act(async () => {
      capture.current = await startVoiceCapture({ ...voice, onLevel: setLevel, onSilence: () => { capture.current?.abort(); capture.current = null; setLevel(null); } });
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'));
      setPermission('Microphone accessible');
    });
  };
  const rows = engineRows(status, voice);
  return <section className={compact ? 'space-y-3' : 'card mt-5 p-5'} aria-label="Voice settings">
    <h2 className="font-semibold">Dictation</h2>
    <p className="mt-1 text-[12px] text-ink-faint">Speech models run on this computer; audio is never sent anywhere. Pick the one dictation uses.</p>
    <button type="button" className="mt-1 text-[12px] text-(--accent) hover:underline" onClick={() => setIntro(true)}>Watch how voice works</button>
    {intro && <Suspense fallback={null}><VoiceIntro onClose={() => setIntro(false)} /></Suspense>}
    <ul className="mt-3 space-y-1.5" aria-label="Speech engines">
      {rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium">{row.name}{row.active && <span className="ml-2 rounded-full px-2 py-0.5 text-[10.5px]" style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }}>In use</span>}</p>
          <p className="text-[11px] text-ink-faint">{row.detail}</p>
          {row.error && <p role="alert" className="text-[11px] text-(--danger)">{row.error}</p>}
        </div>
        {row.installed && !row.active && <button className="btn btn-primary py-1! text-[12px]!" onClick={() => void update({ engine: row.id, enabled: true })}>Use</button>}
        {row.active && <button className="btn btn-outline py-1! text-[12px]!" onClick={() => void update({ enabled: false })}>Turn off</button>}
        {row.action === 'install' && !row.installing && <button className="btn btn-primary py-1! text-[12px]!" onClick={() => void act(async () => { await window.nekko.voiceInstall(row.id); await update({ engine: row.id, enabled: true }); })}>{row.id === 'apple' ? 'Install language pack' : 'Download'}</button>}
        {row.installing && row.id === 'whisper' && <button className="btn btn-outline py-1! text-[12px]!" onClick={() => void act(() => window.nekko.voiceCancelInstall())}>Cancel download</button>}
        {row.installing && row.id === 'apple' && <span className="text-[12px] text-ink-soft">Downloading…</span>}
        {row.action === 'remove' && !row.installing && <button className="btn btn-outline py-1! text-[12px]!" onClick={() => { if (window.confirm(row.id === 'apple' ? 'Release the Apple speech language pack? macOS may keep it for other apps.' : 'Remove the downloaded Nekko Voice runtime and model? Custom files are not deleted.')) void act(async () => { if (row.active) await update({ enabled: false }); await window.nekko.voiceUninstall(row.id); }); }}>{row.id === 'apple' ? 'Remove' : 'Uninstall'}</button>}
      </li>)}
      {!rows.length && <li className="text-[12px] text-ink-soft">Checking speech engines…</li>}
    </ul>
    {!compact && <div className="mt-4 space-y-3 text-[13px]">
      {status?.engine === 'whisper' && <><label className="block">Speech model<input className="input mt-1" value={voice.modelPath ?? ''} placeholder="Recommended Nekko Voice model" onChange={e => void update({ modelPath: e.target.value || undefined })} /></label>
      <button className="btn btn-outline py-1! text-[12px]!" onClick={() => void act(async () => { const files = await window.nekko.openFilesDialog(); if (files[0]) await update({ modelPath: files[0] }); })}>Choose local Whisper .bin model</button>
      <p className="text-[11px] text-ink-faint">Only whisper.cpp speech models are compatible. Custom models keep their own license; choose multilingual weights before using other languages.</p>
      <label className="block">Custom whisper-server path<input className="input mt-1" value={voice.runtimePath ?? ''} placeholder="Use downloaded runtime" onChange={e => void update({ runtimePath: e.target.value || undefined })} /></label>
      </>}
      <label className="block">Recognition language<input className="input mt-1" value={voice.language ?? 'en'} onChange={e => void update({ language: e.target.value })} placeholder="en, es, fr, auto (multilingual only)" /></label>
      <label className="block">Microphone<select className="input mt-1" value={voice.deviceId ?? ''} onChange={e => void update({ deviceId: e.target.value || undefined })}><option value="">System default</option>{devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}</select></label>
      <div className="flex flex-wrap gap-2"><button className="btn btn-outline py-1! text-[12px]!" onClick={() => void test()}>{level === null ? 'Test microphone / grant access' : 'Stop microphone test'}</button><button className="btn btn-outline py-1! text-[12px]!" onClick={() => void act(async () => { const p = await window.nekko.voicePermission('settings'); setPermission(`${p.platform}: ${p.status}`); })}>Open microphone privacy settings</button><button className="btn btn-outline py-1! text-[12px]!" onClick={() => void act(async () => { const p = await window.nekko.voicePermission('status'); setPermission(`${p.platform}: ${p.status}`); })}>Check access</button></div>
      <p className="text-[11px] text-ink-faint">{permission}. OS blocks must be changed in system settings. On Linux, check your desktop sound/privacy settings.</p>
      {level !== null && <meter aria-label="Microphone level" className="w-full" min={0} max={1} value={level} />}
      <label className="block">Speech sensitivity · {voice.sensitivity ?? 60}<input className="mt-1 w-full" type="range" min="0" max="100" value={voice.sensitivity ?? 60} onChange={e => void update({ sensitivity: Number(e.target.value) })} /></label>
      <p className="text-[11px] text-ink-faint">Higher detects quieter speech but may pick up background noise. This does not change model accuracy.</p>
      <label className="block">End utterance after silence (ms)<input className="input mt-1" type="number" min="300" max="5000" value={voice.silenceMs ?? 1200} onChange={e => void update({ silenceMs: Number(e.target.value) })} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={voice.commandsEnabled !== false} onChange={e => void update({ commandsEnabled: e.target.checked })} />Enable “Nekko…” commands</label>
      {status?.engine === 'whisper' && <><label className="block">CPU threads<input className="input mt-1" type="number" min="1" max="8" value={voice.threads ?? 2} onChange={e => void update({ threads: Number(e.target.value) })} /></label>
      <label className="block">Unload speech model after idle (seconds)<input className="input mt-1" type="number" min="10" max="600" value={voice.idleSeconds ?? 60} onChange={e => void update({ idleSeconds: Number(e.target.value) })} /></label>
      </>}
      <button className="btn btn-outline py-1! text-[12px]!" onClick={() => void update({ sensitivity: 60, silenceMs: 1200, threads: 2, idleSeconds: 60 })}>Reset detection settings</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-[12px] text-(--danger)">{error}</p>}
  </section>;
}
