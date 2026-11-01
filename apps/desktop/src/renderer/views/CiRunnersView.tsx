import React, { useEffect, useRef, useState } from 'react';
import { PRIORITY_LABELS, type RunnerView } from '@nekko-agent/shared';
import { Badge, EmptyHint } from '../components/primitives/index.js';
import { RunnerCard } from '../components/RunnerCard.js';
import { ConnectRunnerSheet } from '../components/ConnectRunnerSheet.js';
import { RunnerSettingsSheet } from '../components/RunnerSettingsSheet.js';
import { LaptopIcon, PlugIcon, ShieldIcon } from '../icons.js';
import { hasAppChrome } from '../chrome.js';

export type RunnersState = { kind: 'loading' } | { kind: 'unavailable'; message: string } | { kind: 'ready'; views: RunnerView[] };

/** Mockup 1: the CI runners section before any runner is connected. */
export function CiRunnersFirstVisit({ onConnect }: { onConnect(): void }) {
  return (
    <div className="mt-4 rounded-xl border border-dashed px-4 py-6 text-center" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      <div className="mx-auto mb-2 grid h-13 w-13 place-items-center rounded-xl" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
        <LaptopIcon className="h-6.5 w-6.5" />
      </div>
      <h2 className="mb-1 text-xl font-semibold">Use this Mac as a CI runner</h2>
      <p className="mx-auto mb-3 max-w-130 text-sm text-ink-soft">
        Run your GitHub Actions jobs here, each in a throwaway VM that is deleted afterward. Your own work comes first.
      </p>
      <button className="btn btn-primary" onClick={onConnect}>
        <PlugIcon className="h-4 w-4" /> Connect GitHub
      </button>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
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
  { now, onConnect, onSettings, beginReply }: { now: number; onConnect(): void; onSettings(id: string): void; beginReply(): (v: RunnerView) => void },
): React.ReactNode {
  if (state.kind === 'loading') return null;
  if (state.kind === 'unavailable') {
    // A daemon without runners (not macOS, or older) answers "unknown channel runner:list".
    const text = state.message.startsWith('unknown channel')
      ? "CI runners aren't available here. They need a Mac with Apple silicon and an up-to-date Nekko service."
      : `CI runners aren't available here: ${state.message}`;
    return <EmptyHint className="mt-4">{text}</EmptyHint>;
  }
  if (!state.views.length) return <CiRunnersFirstVisit onConnect={onConnect} />;
  return state.views.map((v) => (
    <RunnerCard key={v.config.id} view={v} now={now} onSettings={() => onSettings(v.config.id)} beginReply={beginReply} />
  ));
}

/** Applies a `listRunners` result (the first, or a retry after "unavailable"): a push that already arrived is newer, so it wins. */
export function afterList(current: RunnersState, listed: RunnersState): RunnersState {
  return current.kind === 'ready' ? current : listed;
}

/**
 * Applies a channel reply (or a new runner) unless a `runner:changed` push
 * arrived after its request started: that push is newer, and the daemon will
 * not push again for a state it already sent. `since` and `seq` count pushes.
 */
export function afterReply(current: RunnersState, v: RunnerView, since: number, seq: number): RunnersState {
  if (since !== seq) return current;
  const views = current.kind === 'ready' ? current.views : [];
  const id = v.config.id;
  return { kind: 'ready', views: views.some((x) => x.config.id === id) ? views.map((x) => (x.config.id === id ? v : x)) : [...views, v] };
}

/** Retry an unavailable list every 2 s, doubling, at most every minute (no reconnect event reaches the renderer). */
export const retryDelay = (attempt: number) => Math.min(60_000, 2000 * 2 ** attempt);

const nowSecs = () => Date.now() / 1000;

/** The Workflows tab's CI runners section: this Mac's runners from nekkod. */
export function CiRunnersView({ segment, now = nowSecs }: { segment?: React.ReactNode; now?: () => number }) {
  const [state, setState] = useState<RunnersState>({ kind: 'loading' });
  const [clock, setClock] = useState(now);
  const [connecting, setConnecting] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const pushes = useRef(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const list = (attempt: number) => window.nekko.listRunners().then(
      (views) => live && setState((s) => afterList(s, { kind: 'ready', views })),
      (e: unknown) => {
        if (!live) return;
        setState((s) => afterList(s, { kind: 'unavailable', message: e instanceof Error ? e.message : String(e) }));
        timer = setTimeout(() => void list(attempt + 1), retryDelay(attempt));
      },
    );
    void list(0);
    const off = window.nekko.onRunnersChanged((views) => {
      pushes.current += 1;
      clearTimeout(timer);
      setState({ kind: 'ready', views });
    });
    return () => {
      live = false;
      clearTimeout(timer);
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

  // Called as a request starts; its answer applies only if no push overtook it. A new runner may beat its push, so it is added.
  const beginReply = () => {
    const since = pushes.current;
    return (v: RunnerView) => setState((s) => afterReply(s, v, since, pushes.current));
  };
  const hasRunners = state.kind === 'ready' && state.views.length > 0;
  // A removed runner's push drops it from the list, which closes its sheet.
  const settingsView = state.kind === 'ready' ? state.views.find((v) => v.config.id === settingsFor) : undefined;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-center gap-2">
          {!hasAppChrome && <h1 className="view-title">CI runners</h1>}
          {segment}
          {hasRunners && (
            <button className="btn btn-outline ml-auto py-1!" onClick={() => setConnecting(true)}>
              <PlugIcon className="h-3.5 w-3.5" /> Connect GitHub
            </button>
          )}
        </div>
        {runnersBody(state, { now: clock, onConnect: () => setConnecting(true), onSettings: setSettingsFor, beginReply })}
      </div>
      {connecting && (
        // shortcut: views do not carry the GitHub app id yet, so connect always asks for the key; pass a real lookup once they do.
        <ConnectRunnerSheet onClose={() => setConnecting(false)} onConnected={() => setConnecting(false)} beginReply={beginReply} keyStoredFor={() => false} />
      )}
      {settingsView && <RunnerSettingsSheet view={settingsView} onClose={() => setSettingsFor(null)} beginReply={beginReply} />}
    </div>
  );
}
