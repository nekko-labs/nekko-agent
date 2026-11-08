import React, { useEffect, useState } from 'react';
import { useStore } from '../../store.js';
import { useExpertMode, useSimpleChoices } from '../../simpleMode.js';
import { loadWallState, saveWallState, toWallSetting } from '../../commandWall.js';
import { ChevronDownIcon, FileIcon, PencilIcon, TerminalIcon } from '../../icons.js';
import { LEVELS, MINIMAL_HIDES, currentLevel, levelForProfile, monitorsDefault, type DetailLevel } from './aboutYou.js';
import { SetupNekko } from './AboutYouSteps.js';

type CommitRef = React.MutableRefObject<(() => Promise<void | boolean>) | null>;

const REPLY = 'The expiry check compared seconds with milliseconds, so every token looked expired. I fixed the comparison in auth.ts and all 48 tests pass now.';
const STEPS = [
  { Icon: FileIcon, verb: 'Read', arg: 'src/auth.ts', meta: '' },
  { Icon: TerminalIcon, verb: 'Ran', arg: 'npm test', meta: '2 failed' },
  { Icon: PencilIcon, verb: 'Edited', arg: 'src/auth.ts', meta: '+2 −1' },
  { Icon: TerminalIcon, verb: 'Ran', arg: 'npm test', meta: '48 passed' },
];

/** Replays the sample reply every ~12 s; reduced motion shows it finished. */
function useReplay(key: string) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setTick(999); return; }
    const t = setInterval(() => setTick((n) => (n + 1) % 110), 110);
    return () => clearInterval(t);
  }, [key]);
  return tick;
}

function Preview({ level, monitors }: { level: DetailLevel; monitors: boolean }) {
  const tick = useReplay(level);
  const detailed = level === 'detailed';
  const steps = detailed ? Math.max(0, Math.min(4, Math.floor((tick - 6) / 6))) : 0;
  const chars = Math.max(0, Math.min(REPLY.length, (tick - (detailed ? 34 : 6)) * 5));
  const done = chars >= REPLY.length;
  const cpu = Math.round(34 + 14 * Math.sin(tick / 7));
  return (
    <div className="flex h-[440px] min-w-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface" aria-label={`Preview of a chat in ${level}`} role="img">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center justify-between border-b border-line px-4 text-sm font-semibold">
          Fix the login test
          {level !== 'minimal' && done && <span className="text-xs font-normal text-ink-soft">1 file changed</span>}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
          <div className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2.5 text-sm">Why is the login test failing?</div>
          <div className="flex items-start gap-2.5">
            <SetupNekko size={22} />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              {detailed && (
                <div className="rounded-lg bg-surface-2 px-3 py-2.5">
                  <div className="text-xs font-semibold text-ink-soft">Thought for 4s</div>
                  <div className="mt-1 text-xs leading-relaxed text-ink-soft">tokenIsValid compares exp, in seconds, with Date.now(), in milliseconds. Fix the unit, then rerun the suite.</div>
                </div>
              )}
              {STEPS.slice(0, steps).map(({ Icon, verb, arg, meta }, i) => (
                <div key={i} className="flex h-6 items-center gap-2 font-mono text-xs text-ink-soft">
                  <Icon className="h-3.5 w-3.5" /><span className="text-ink">{verb}</span><span>{arg}</span>
                  <span className={`ml-auto ${meta.includes('failed') ? 'text-danger' : meta.includes('passed') ? 'text-accent' : ''}`}>{meta}</span>
                </div>
              ))}
              <p className="text-sm leading-relaxed">{REPLY.slice(0, chars)}{!done && chars > 0 && <span className="ml-0.5 inline-block h-4 w-2 bg-accent align-[-2px]" />}</p>
              {level === 'regular' && done && (
                <div className="flex flex-wrap gap-2 text-xs text-ink-soft">
                  <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-line px-2.5">4 steps <ChevronDownIcon className="h-3 w-3" /></span>
                  <span className="inline-flex h-7 items-center rounded-lg border border-line px-2.5">auth.ts +2 −1</span>
                </div>
              )}
              {detailed && done && <div className="font-mono text-2xs text-ink-soft">1.8k tokens · 52 tok/s · 6.4s</div>}
            </div>
          </div>
        </div>
      </div>
      {monitors && (
        <div className="flex w-44 shrink-0 flex-col gap-3 border-l border-line bg-paper p-4">
          <div className="text-xs font-semibold">Monitors</div>
          {[['CPU', cpu], ['Memory', 61], ['GPU', 12]].map(([label, pct]) => (
            <div key={label}>
              <div className="flex justify-between text-2xs text-ink-soft"><span>{label}</span><span className="font-mono text-ink">{pct}%</span></div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-surface-2"><div className="h-1.5 rounded bg-accent" style={{ width: `${pct}%` }} /></div>
            </div>
          ))}
          <div className="mt-1 border-t border-line pt-3 text-2xs text-ink-soft">Agents
            <div className="mt-1.5 flex items-center gap-1.5 text-ink"><span className="h-2 w-2 rounded-full bg-accent" />test-runner</div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Minimal, Regular or Detailed, with a sample chat that replays at the chosen
 * level, and the Monitors switch. Applied on Next: Detailed turns on Detailed
 * mode; Minimal is Simple mode with MINIMAL_HIDES hidden; the switch opens or
 * closes the Monitors panel in both modes.
 */
export function DetailStep({ commitRef }: { commitRef: CommitRef }) {
  const profile = useStore((s) => s.settings?.workProfile);
  const [expert, setExpert] = useExpertMode();
  const [choices, setChoice] = useSimpleChoices();
  const recommended = levelForProfile(profile);
  const [level, setLevel] = useState<DetailLevel>(() => (profile ? recommended : currentLevel(expert, choices as Record<string, string>)));
  const [monitorsPick, setMonitorsPick] = useState<boolean | null>(null);
  const monitors = monitorsPick ?? monitorsDefault(level);

  useEffect(() => {
    commitRef.current = async () => {
      setExpert(level === 'detailed');
      for (const id of MINIMAL_HIDES) setChoice(id, level === 'minimal' ? 'hide' : null);
      const settings = useStore.getState().settings;
      if (!settings) return;
      const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
      const wall = loadWallState(storage, settings.commandWall);
      const next = { ...wall, dock: { ...wall.dock, show: monitors, simpleShow: monitors } };
      saveWallState(storage, next);
      useStore.setState({ settings: await window.nekko.updateSettings({ commandWall: toWallSetting(next) }) });
    };
    return () => { commitRef.current = null; };
  }, [commitRef, level, monitors, setExpert, setChoice]);

  return (
    <div className="flex w-full items-center gap-8">
      <div className="flex w-80 shrink-0 flex-col">
        <h1 id="setup-detail" className="text-2xl font-semibold tracking-tight">How much detail do you like?</h1>
        <p className="mt-2 text-sm text-ink-soft">Same answer, three ways. Try each one.</p>
        <div role="radiogroup" aria-labelledby="setup-detail" className="mt-5 flex flex-col gap-2">
          {LEVELS.map((l, i) => {
            const on = l.id === level;
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => { setLevel(l.id); setMonitorsPick(null); }}
                className={`setup-card flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${on ? 'is-on border-accent' : 'border-line bg-surface hover:bg-surface-2'}`}
              >
                <span className={`flex h-8 w-8 shrink-0 flex-col justify-center gap-[3px] rounded-lg px-2 ${on ? 'bg-accent' : 'bg-surface-2'}`} aria-hidden="true">
                  {[1, 0.7, 0.85].map((w, b) => <span key={b} className={`h-[3px] rounded ${on ? 'bg-on-accent' : 'bg-ink'}`} style={{ width: `${w * 100}%`, opacity: b <= i ? 1 : 0.25 }} />)}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-semibold">{l.title}
                    {profile && l.id === recommended && <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-soft">Suggested</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-soft">{l.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
        <label className="mt-4 flex items-center gap-3 border-t border-line pt-4">
          <span className="flex-1">
            <span className="block text-sm font-semibold">Show monitors</span>
            <span className="block text-xs text-ink-soft">CPU, memory, GPU and agents at work.</span>
          </span>
          <input type="checkbox" role="switch" className="setup-switch" checked={monitors} onChange={(e) => setMonitorsPick(e.target.checked)} />
        </label>
        <p className="mt-3 text-2xs text-ink-faint">Switch any time with Simple / Detailed, or in Settings › Simple mode.</p>
      </div>
      <Preview level={level} monitors={monitors} />
    </div>
  );
}
