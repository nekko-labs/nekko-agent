import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { VoiceSettings } from './VoiceSettings.js';
import { useStore } from '../store.js';
import { voiceListener, type VoiceTarget } from '../voiceActions.js';

const VoiceIntro = lazy(() => import('./VoiceIntro.js'));

/**
 * The always-on microphone. One capture serves the whole app (voiceActions.ts);
 * every mounted composer registers here so each segment lands in the chat that
 * is focused when it finishes.
 */
export function DictationButton(props: VoiceTarget) {
  const { sessionId } = props;
  const target = useRef(props);
  target.current = props;
  const voice = useStore(s => s.settings?.voice);
  useStore(s => s.activeSessionId);
  const snap = useSyncExternalStore(voiceListener.subscribe, voiceListener.snapshot, voiceListener.snapshot);
  const [setup, setSetup] = useState(false);
  const [intro, setIntro] = useState(false);
  useEffect(() => voiceListener.register(sessionId, () => target.current), [sessionId]);
  // Choosing an engine in the setup popover is the whole setup: close it. (Voice-off stops listening in voiceActions.)
  useEffect(() => { if (voice?.enabled && setup) setSetup(false); }, [voice?.enabled, setup]);
  const listen = async () => { if (await voiceListener.start(sessionId) === 'setup') setSetup(true); };
  const toggle = async () => {
    if (snap.listening) { void voiceListener.stop(); return; }
    // The first tap shows the video; its Turn on starts listening, Not now does not.
    if (!voice?.introSeen) { setIntro(true); return; }
    await listen();
  };
  // Only one composer shows the strip and any confirm: the one text would land in.
  const shown = voiceListener.displaySessionId() === sessionId;
  const pending = shown ? snap.pending : null;
  const busy = snap.busy === 'starting' ? 'Checking local speech…' : snap.busy === 'transcribing' ? 'Transcribing locally…' : '';
  return (
    <div className="relative shrink-0">
      <button type="button" className={`grid h-9 w-9 place-items-center rounded-xl hover:bg-surface-2 disabled:opacity-40 ${snap.listening ? 'text-(--danger)' : 'text-ink-soft'}`}
        onClick={() => void toggle()} disabled={snap.busy === 'starting'} aria-pressed={snap.listening}
        aria-label={snap.listening ? 'Stop listening' : 'Start listening'} title="Always-on local dictation · Say ‘Nekko…’ for app commands">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>
      {intro && <Suspense fallback={null}><VoiceIntro onClose={() => setIntro(false)} onTurnOn={() => void listen()} /></Suspense>}
      {setup && <div className="absolute bottom-full right-0 z-40 mb-2 w-80 rounded-xl border border-line bg-surface p-3 shadow-(--shadow-float)"><VoiceSettings compact /><button className="mt-2 text-xs" onClick={() => setSetup(false)}>Close setup</button></div>}
      {shown && (snap.listening || busy || pending || snap.error) && <div className="absolute bottom-full right-0 z-40 mb-2 w-72 rounded-xl border border-line bg-surface p-3 shadow-(--shadow-float)" data-voice-strip>
        {(snap.listening || busy) && <div role="status" className="flex items-center gap-2 text-xs text-ink-soft">
          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <span className="block h-full rounded-full bg-(--danger) transition-[width] duration-100" style={{ width: Math.round(Math.min(1, snap.level) * 100) + '%' }} />
          </span>
          <span className="min-w-0 truncate">{busy || (snap.heard ? `Heard: ${snap.heard}` : 'Listening locally… Say ‘Nekko…’ for commands.')}</span>
        </div>}
        {pending && <div className={snap.listening || busy ? 'mt-2' : ''}>
          <p className="text-xs">{pending.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {pending.kind === 'confirm'
              ? <button className="btn btn-primary py-1! text-xs!" onClick={() => void voiceListener.answer({ kind: 'yes' })}>Confirm</button>
              : pending.options.map((option, i) => <button key={i} className="btn btn-outline max-w-full truncate py-1! text-xs!" onClick={() => void voiceListener.answer({ kind: 'pick', n: (i + 1) as 1 | 2 | 3 })}>{i + 1}. {option.label}</button>)}
            <button className="btn btn-outline py-1! text-xs!" onClick={() => void voiceListener.answer({ kind: 'no' })}>Cancel</button>
          </div>
        </div>}
        {snap.error && <><p role="alert" className="mt-1 text-xs text-(--danger)">{snap.error}</p><button className="mt-2 text-xs text-ink-soft" onClick={voiceListener.dismissError}>Dismiss</button></>}
      </div>}
    </div>
  );
}
