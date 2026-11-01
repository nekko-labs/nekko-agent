import React, { useEffect, useRef, useState } from 'react';
import type { ImageView, RunnerView } from '@nekko-agent/shared';
import { EmptyHint } from '../components/primitives/index.js';
import { RunnerCard } from '../components/RunnerCard.js';
import { ConnectRunnerSheet } from '../components/ConnectRunnerSheet.js';
import { RunnerSettingsSheet } from '../components/RunnerSettingsSheet.js';
import { MacSetupSheet } from '../components/MacSetupSheet.js';
import { connectToWorkflow } from '../components/RunnerReady.js';
import { GithubStepArt, MacStepArt } from '../components/RunnerStepArt.js';
import { CheckIcon, PlugIcon } from '../icons.js';
import { hasAppChrome } from '../chrome.js';

export type RunnersState = { kind: 'loading' } | { kind: 'unavailable'; message: string } | { kind: 'ready'; views: RunnerView[] };

const StepPanel = ({ step, art, title, blurb, next, children }: { step: number; art: React.ReactNode; title: string; blurb: string; next?: boolean; children: React.ReactNode }) => (
  <article className={`runner-step${next ? ' next' : ''}`}>
    <div className="art">{art}</div>
    <div className="body">
      <span className="eyebrow">{`STEP ${step}`}</span>
      <b>{title}</b>
      <p>{blurb}</p>
      {children}
    </div>
  </article>
);

/**
 * Frame 1: both steps are visible from the start. `connected` is step 1 done, so
 * step 2 lights up; a stopped build offers to pick up where it left off.
 */
export function CiRunnersFirstVisit({ connected = false, canResume = false, onConnect, onSetup }: { connected?: boolean; canResume?: boolean; onConnect(): void; onSetup?(): void }) {
  return (
    <div className="mx-auto mt-4 flex max-w-170 flex-col gap-2.5 rounded-[14px] border p-4" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      <h2 className="text-[15.5px] font-semibold">Use this Mac as a CI runner</h2>
      <p className="text-[13.5px] text-ink-soft">Run your GitHub Actions jobs here, each in a throwaway VM that is deleted afterward. Your own work comes first.</p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-3.5">
        <StepPanel step={1} art={<GithubStepArt />} title="Connect GitHub" blurb="Two clicks on GitHub. Nothing to copy." next={connected}>
          {connected
            ? <span className="mt-auto flex items-center gap-1.5 text-[13px] font-medium text-[var(--success)]"><CheckIcon className="h-3.5 w-3.5" />Connected</span>
            : <button className="btn btn-primary mt-auto self-start" onClick={onConnect}>Connect GitHub</button>}
        </StepPanel>
        <StepPanel step={2} art={<MacStepArt />} title="Set up this Mac" blurb="One click, then it builds your job VM by itself." next={!connected}>
          {connected
            ? <button className="btn btn-primary mt-auto self-start" onClick={onSetup}>{canResume ? 'Resume setup' : 'Set up this Mac'}</button>
            : <button className="btn btn-outline mt-auto self-start" disabled>After step 1</button>}
        </StepPanel>
      </div>
    </div>
  );
}

/** The section body for each load state; pure so tests can render it without effects. */
export function runnersBody(
  state: RunnersState,
  { now, image = null, onConnect, onSettings, onSetup, beginReply }: { now: number; image?: ImageView | null; onConnect(): void; onSettings(id: string): void; onSetup?(id: string): void; beginReply(): (v: RunnerView) => void },
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
  const first = state.views[0].config.id;
  return (
    <>
      {image?.state === 'none' && <CiRunnersFirstVisit connected canResume={image.canResume} onConnect={onConnect} onSetup={() => onSetup?.(first)} />}
      {state.views.map((v) => (
        <RunnerCard key={v.config.id} view={v} now={now} image={image} onSettings={() => onSettings(v.config.id)} onSetup={() => onSetup?.(v.config.id)} beginReply={beginReply} />
      ))}
    </>
  );
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
  const [setup, setSetup] = useState<{ id: string; rebuild: boolean } | null>(null);
  const [image, setImage] = useState<ImageView | null>(null);

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

  // Rejects on a daemon with no builder: the card then keeps its error line.
  useEffect(() => {
    let live = true;
    void window.nekko.imageStatus().then((v) => { if (live) setImage((cur) => cur ?? v); }, () => {});
    const off = window.nekko.onImageChanged(setImage);
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

  // Called as a request starts; its answer applies only if no push overtook it. A new runner may beat its push, so it is added.
  const beginReply = () => {
    const since = pushes.current;
    return (v: RunnerView) => setState((s) => afterReply(s, v, since, pushes.current));
  };
  const hasRunners = state.kind === 'ready' && state.views.length > 0;
  // A removed runner's push drops it from the list, which closes its sheet.
  const settingsView = state.kind === 'ready' ? state.views.find((v) => v.config.id === settingsFor) : undefined;
  const setupView = state.kind === 'ready' ? state.views.find((v) => v.config.id === setup?.id) : undefined;

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
        {runnersBody(state, { now: clock, image, onConnect: () => setConnecting(true), onSettings: setSettingsFor, onSetup: (id) => setSetup({ id, rebuild: false }), beginReply })}
      </div>
      {connecting && (
        // shortcut: views do not carry the GitHub app id yet, so connect always asks for the key; pass a real lookup once they do.
        <ConnectRunnerSheet
          onClose={() => setConnecting(false)}
          onConnected={(id) => {
            setConnecting(false);
            if (id) setSetup({ id, rebuild: false });
          }}
          beginReply={beginReply}
          keyStoredFor={() => false}
        />
      )}
      {settingsView && (
        <RunnerSettingsSheet
          view={settingsView}
          image={image}
          onClose={() => setSettingsFor(null)}
          onRebuild={() => {
            setSettingsFor(null);
            setSetup({ id: settingsView.config.id, rebuild: true });
          }}
          beginReply={beginReply}
        />
      )}
      {setup && (
        <MacSetupSheet
          runnerId={setup.id}
          view={setupView}
          image={image}
          rebuild={setup.rebuild}
          onClose={() => setSetup(null)}
          onWorkflow={() => {
            setSetup(null);
            if (setupView) void connectToWorkflow(setupView);
          }}
          beginReply={beginReply}
        />
      )}
    </div>
  );
}
