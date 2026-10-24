import { useEffect, useRef, useState } from 'react';
import { startVoiceCapture } from '../voiceCapture.js';
import { VoiceSettings } from './VoiceSettings.js';
import { parseVoiceIntent, type VoiceIntent } from '../voiceCommands.js';
import { displaysBridge } from '../displays.js';
import { useStore } from '../store.js';

export function DictationButton({ sessionId, onText }: { sessionId: string; onText: (text: string) => void }) {
  const recognition = useRef<Awaited<ReturnType<typeof startVoiceCapture>> | null>(null);
  const mounted = useRef(true);
  const textCallback = useRef(onText);
  textCallback.current = onText;
  const [state, setState] = useState<'idle' | 'starting' | 'listening' | 'transcribing'>('idle');
  const [interim, setInterim] = useState('');
  const [setup, setSetup] = useState(false);
  const voice = useStore(s => s.settings?.voice);
  const [pending, setPending] = useState<VoiceIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; recognition.current?.abort(); recognition.current = null; };
  }, [sessionId]);
  const execute = async (intent: VoiceIntent) => {
    setBusy(true);
    try {
      if (intent.kind === 'new-session') await useStore.getState().newChat();
      else if (intent.kind === 'complete-session') await useStore.getState().archiveChat(sessionId);
      else if (intent.kind === 'navigate') useStore.getState().setView(intent.view);
      else if (intent.kind === 'go') {
        const result = displaysBridge ? await displaysBridge.go(intent.target) : 'not-found';
        if (result === 'needs-access') throw new Error('Switching desktops needs the Accessibility permission: turn on Switch me there in the Agents Screens menu.');
        if (result === 'not-found') throw new Error(`There is no ${intent.target.kind} ${'n' in intent.target ? intent.target.n : 'that way'}.`);
      }
      setPending(null);
    } catch (e) { setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const finish = async () => {
    const current = recognition.current;
    if (!current) return;
    recognition.current = null;
    const wav = current.stop();
    setState('transcribing');
    try {
      const text = await window.nekko.voiceTranscribe(wav);
      if (!mounted.current || !text || !useStore.getState().settings?.voice?.enabled) return;
      const intent = voice?.commandsEnabled === false ? { kind: 'dictation' as const, text } : parseVoiceIntent(text);
      if (intent.kind === 'dictation') textCallback.current(intent.text);
      // Switching desktops or screens is harmless and undone by saying it again, so it runs without a confirm.
      else if (intent.kind === 'go') void execute(intent);
      else setPending(intent);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) { setState('idle'); setInterim(''); } }
  };
  useEffect(() => {
    if (!voice?.enabled && recognition.current) { recognition.current.abort(); recognition.current = null; setState('idle'); }
    // Choosing an engine in the setup popover is the whole setup: close it.
    if (voice?.enabled && setup) setSetup(false);
  }, [voice?.enabled, setup]);
  const toggle = async () => {
    if (recognition.current) { void finish(); return; }
    if (state !== 'idle') return;
    setError('');
    setState('starting');
    try {
      const status = await window.nekko.voiceStatus();
      if (!voice?.enabled || !status.installed) { setSetup(true); setState('idle'); return; }
      const local = await startVoiceCapture({ ...voice, onLevel: n => setInterim('Microphone level: ' + Math.round(n * 100) + '%'), onSilence: () => { void finish(); } });
      if (!mounted.current || !useStore.getState().settings?.voice?.enabled) { local.abort(); return; }
      recognition.current = local;
      setState('listening');
    } catch (e) { if (mounted.current) { setError((e as Error).message); setState('idle'); } }
  };
  return (
    <div className="relative shrink-0">
      <button type="button" className={`grid h-9 w-9 place-items-center rounded-xl hover:bg-surface-2 disabled:opacity-40 ${state === 'listening' ? 'text-(--danger)' : 'text-ink-soft'}`}
        onClick={() => void toggle()} disabled={state === 'starting' || state === 'transcribing' || !!pending} aria-pressed={state === 'listening'}
        aria-label={state === 'listening' ? 'Stop dictation' : 'Start local dictation'} title="Local dictation · Say ‘Nekko…’ for app commands">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>
      {setup && <div className="absolute bottom-full right-0 z-40 mb-2 w-80 rounded-xl border border-line bg-surface p-3 shadow-lg"><VoiceSettings compact /><button className="mt-2 text-[12px]" onClick={() => setSetup(false)}>Close setup</button></div>}
      {(state !== 'idle' || pending || error) && <div className="absolute bottom-full right-0 z-40 mb-2 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg">
        <p role="status" className="text-[12px] text-ink-soft">{state === 'transcribing' ? 'Transcribing locally…' : state === 'starting' ? 'Checking local speech…' : state === 'listening' ? interim || 'Listening locally… Click the microphone to stop.' : pending ? 'Voice command' : 'Dictation unavailable'}</p>
        {pending && <>
          <p className="mt-1 text-[12px]">{pending.kind === 'new-session' ? 'Create a new session?' : pending.kind === 'complete-session' ? 'Complete this session?' : pending.kind === 'navigate' ? `Open ${pending.view === 'modelserver' ? 'Model Server' : pending.view}?` : pending.kind === 'unknown' ? `Unrecognized command: ${pending.text}` : ''}</p>
          <div className="mt-2 flex gap-2">
            {pending.kind === 'unknown' ? <button className="btn btn-outline py-1! text-[12px]!" onClick={() => { textCallback.current(pending.text); setPending(null); }}>Add to draft</button>
              : <button disabled={busy} className="btn btn-primary py-1! text-[12px]!" onClick={() => void execute(pending)}>Confirm</button>}
            <button disabled={busy} className="btn btn-outline py-1! text-[12px]!" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </>}
        {error && <><p role="alert" className="mt-1 text-[12px] text-(--danger)">{error}</p><button className="mt-2 text-[12px] text-ink-soft" onClick={() => setError('')}>Dismiss</button></>}
      </div>}
    </div>
  );
}
