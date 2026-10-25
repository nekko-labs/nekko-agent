import React, { useEffect, useState } from 'react';
import { PRIORITY_LABELS, type RunnerView } from '@nekko-agent/shared';
import { Badge, EmptyHint } from '../components/primitives/index.js';
import { RunnerCard } from '../components/RunnerCard.js';
import { LaptopIcon, PlugIcon, ShieldIcon } from '../icons.js';
import { hasAppChrome } from '../chrome.js';

export type RunnersState = { kind: 'loading' } | { kind: 'unavailable'; message: string } | { kind: 'ready'; views: RunnerView[] };

/** Mockup 1: the CI runners section before any runner is connected. */
export function CiRunnersFirstVisit({ onConnect }: { onConnect(): void }) {
  return (
    <div className="mt-4 rounded-xl border border-dashed px-4 py-6 text-center" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      <div className="mx-auto mb-2.5 grid h-13 w-13 place-items-center rounded-xl" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
        <LaptopIcon className="h-6.5 w-6.5" />
      </div>
      <h2 className="mb-1 text-[18px] font-semibold">Use this Mac as a CI runner</h2>
      <p className="mx-auto mb-3.5 max-w-130 text-[13.5px] text-ink-soft">
        Run your GitHub Actions jobs here, each in a throwaway VM that is deleted afterward. Your own work comes first.
      </p>
      <button className="btn btn-primary" onClick={onConnect}>
        <PlugIcon className="h-4 w-4" /> Connect GitHub
      </button>
      <div className="mt-3.5 flex flex-wrap justify-center gap-1.5">
        <Badge tone="success"><ShieldIcon className="h-3 w-3" />VM per job</Badge>
        <Badge>1 macOS slot</Badge>
        <Badge>{PRIORITY_LABELS.doNotDisturb}</Badge>
        <Badge>Only on power</Badge>
        <Badge>Private repos unless you allow public</Badge>
      </div>
    </div>
  );
}

/** The section body for each load state; pure so tests can render it without effects. */
export function runnersBody(
  state: RunnersState,
  { now, onConnect, onSettings, onChanged }: { now: number; onConnect(): void; onSettings(id: string): void; onChanged(v: RunnerView): void },
): React.ReactNode {
  if (state.kind === 'loading') return null;
  if (state.kind === 'unavailable') return <EmptyHint className="mt-4">CI runners aren't available here: {state.message}</EmptyHint>;
  if (!state.views.length) return <CiRunnersFirstVisit onConnect={onConnect} />;
  return state.views.map((v) => (
    <RunnerCard key={v.config.id} view={v} now={now} onSettings={() => onSettings(v.config.id)} onChanged={onChanged} />
  ));
}

/** Applies the one `listRunners` result: a push that already arrived is newer, so it wins. */
export function afterList(current: RunnersState, listed: RunnersState): RunnersState {
  return current.kind === 'loading' ? listed : current;
}

const nowSecs = () => Date.now() / 1000;

/** The Workflows tab's CI runners section: this Mac's runners from nekkod. */
export function CiRunnersView({ segment, now = nowSecs }: { segment?: React.ReactNode; now?: () => number }) {
  const [state, setState] = useState<RunnersState>({ kind: 'loading' });
  const [clock, setClock] = useState(now);
  // The connect and settings sheets (Task 4) open from these; nothing draws them yet.
  const [connecting, setConnecting] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.nekko.listRunners().then(
      (views) => live && setState((s) => afterList(s, { kind: 'ready', views })),
      (e: unknown) => live && setState((s) => afterList(s, { kind: 'unavailable', message: e instanceof Error ? e.message : String(e) })),
    );
    const off = window.nekko.onRunnersChanged((views) => setState({ kind: 'ready', views }));
    return () => {
      live = false;
      off();
    };
  }, []);

  const running = state.kind === 'ready' && state.views.some((v) => v.slots.some((s) => s.state === 'running'));
  useEffect(() => {
    if (!running) return;
    setClock(now());
    const t = setInterval(() => setClock(now()), 30_000);
    return () => clearInterval(t);
  }, [running, now]);

  const onChanged = (v: RunnerView) =>
    setState((s) => (s.kind === 'ready' ? { kind: 'ready', views: s.views.map((x) => (x.config.id === v.config.id ? v : x)) } : s));
  const hasRunners = state.kind === 'ready' && state.views.length > 0;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-center gap-2">
          {!hasAppChrome && <h1 className="view-title">CI runners</h1>}
          {segment}
          {hasRunners && (
            <button className="btn btn-outline ml-auto py-1.5!" onClick={() => setConnecting(true)}>
              <PlugIcon className="h-3.5 w-3.5" /> Connect GitHub
            </button>
          )}
        </div>
        {runnersBody(state, { now: clock, onConnect: () => setConnecting(true), onSettings: setSettingsFor, onChanged })}
      </div>
    </div>
  );
}
