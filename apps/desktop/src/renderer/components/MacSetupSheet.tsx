import React, { useEffect, useRef, useState } from 'react';
import {
  imageFraction,
  imageStageRows,
  type ImageBuildRequest,
  type ImagePlan,
  type ImageView,
  type Priority,
  type RunnerSettings,
  type RunnerView,
  type StageRow,
} from '@nekko-agent/shared';
import { Modal } from './primitives/index.js';
import { confirmDeletion } from './DeleteConfirmation.js';
import { RunnerReady } from './RunnerReady.js';
import { CheckIcon, MoonIcon, RocketIcon, YinYangIcon } from '../icons.js';

const MODES: { priority: Priority; title: string; blurb: string; Icon(p: { className?: string }): React.JSX.Element }[] = [
  { priority: 'doNotDisturb', title: 'Do not disturb', blurb: "Only run when I'm idle", Icon: MoonIcon },
  { priority: 'balanced', title: 'Balanced', blurb: 'In the background', Icon: YinYangIcon },
  { priority: 'runnerFirst', title: 'Runner first', blurb: 'For a docked Mac', Icon: RocketIcon },
];

/** Measured for macOS 27.2. shortcut: fixed sizes, read Apple's catalog if they drift far. */
const MACOS_SIZE = 'About 26 GB';
const SIMULATOR_SIZE = 'About 8 GB';

export function ModePicker({ priority, onPriority }: { priority: Priority; onPriority(p: Priority): void }) {
  return (
    <div role="radiogroup" aria-label="How this Mac helps" className="flex flex-col gap-2">
      {MODES.map(({ priority: p, title, blurb, Icon }) => (
        <label key={p} className={`runner-pick runner-mode${p === priority ? ' on' : ''}`}>
          <input type="radio" className="sr-only" name="runner-mode" checked={p === priority} onChange={() => onPriority(p)} />
          <span className="mi"><Icon className="h-5 w-5" /></span>
          <span className="min-w-0 flex-1"><b>{title}</b><span>{blurb}</span></span>
          {p === priority && <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--success)]" />}
        </label>
      ))}
    </div>
  );
}

const Kv = ({ label, value }: { label: string; value: string }) => (
  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 text-[13.5px]">
    <span className="text-ink-soft">{label}</span>
    <span className="text-right tabular-nums text-ink">{value}</span>
  </div>
);

const Heading = ({ children }: { children: React.ReactNode }) => <h2 className="text-[15.5px] font-semibold text-ink">{children}</h2>;
const Fine = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-ink-faint">{children}</p>;
const Alert = ({ error }: { error: string | null }) => (error ? <p role="alert" className="runner-note bad">{error}</p> : null);
const Sheet = ({ children }: { children: React.ReactNode }) => <div className="flex flex-col gap-2.5 p-4">{children}</div>;
const Buttons = ({ children }: { children: React.ReactNode }) => <div className="flex flex-wrap justify-end gap-2">{children}</div>;

const Stage = ({ row }: { row: StageRow }) => (
  <div className={`runner-stage ${row.mark}`}>
    {row.mark === 'done' ? <CheckIcon className="h-3.5 w-3.5 justify-self-center text-[var(--success)]" /> : <span className="dot" />}
    <span>{row.label}</span>
    <small>{row.note}</small>
  </div>
);

/** Frame 5, for a Mac with no image, or a rebuild, which keeps the mode it has. */
export function PlanStep({ plan, priority, rebuild, error, busy, onPriority, onBuild }: {
  /** `undefined` while it loads, `null` when the daemon could not say. */
  plan: ImagePlan | null | undefined;
  priority: Priority;
  rebuild: boolean;
  error: string | null;
  busy: boolean;
  onPriority(p: Priority): void;
  onBuild(): void;
}) {
  const noXcode = plan?.xcode === null;
  const needs = plan ? plan.needsGb : 110;
  const free = plan?.freeGb === null || plan?.freeGb === undefined ? '' : ` of ${Math.floor(plan.freeGb)} GB free`;
  return (
    <Sheet>
      <Heading>{rebuild ? 'Rebuild image' : 'Set up this Mac'}</Heading>
      <Kv label="macOS from Apple" value={MACOS_SIZE} />
      {!noXcode && <Kv label="iOS simulator from Apple" value={SIMULATOR_SIZE} />}
      {!noXcode && <Kv label={['Xcode', plan?.xcode, 'from this Mac'].filter(Boolean).join(' ')} value="Copied in" />}
      <Kv label="Space needed" value={`${needs} GB${free}`} />
      {noXcode && (
        <div className="runner-pick on">
          <i className="radio" />
          <div className="min-w-0 flex-1"><b>macOS only</b><span>No Xcode on this Mac. Install Xcode for iOS jobs.</span></div>
        </div>
      )}
      {!rebuild && <ModePicker priority={priority} onPriority={onPriority} />}
      <Fine>{noXcode ? "Continuing accepts Apple's macOS license for this VM." : "Continuing accepts Apple's macOS and Xcode licenses for this VM."}</Fine>
      <Alert error={error} />
      <Buttons>
        <button type="button" className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || plan === undefined} onClick={onBuild}>
          {rebuild ? 'Download and rebuild' : 'Download and set up'}
        </button>
      </Buttons>
    </Sheet>
  );
}

/** This Mac already has an image, so only the mode is asked. */
export function ModeStep({ priority, error, busy, onPriority, onStart }: { priority: Priority; error: string | null; busy: boolean; onPriority(p: Priority): void; onStart(): void }) {
  return (
    <Sheet>
      <Heading>Set up this Mac</Heading>
      <p className="text-[13.5px] text-ink-soft">This Mac already has a VM image. You can change the mode any time.</p>
      <ModePicker priority={priority} onPriority={onPriority} />
      <Alert error={error} />
      <Buttons><button type="button" className="btn btn-primary" disabled={busy} onClick={onStart}>Start runner</button></Buttons>
    </Sheet>
  );
}

/** Frame 6, and the same list when a stopped build offers to resume. */
export function ProgressStep({ image, error, busy, onCancel, onResume }: { image: ImageView; error: string | null; busy: boolean; onCancel(): void; onResume?(): void }) {
  const fraction = imageFraction(image);
  return (
    <Sheet>
      <Heading>{onResume ? 'Setup paused' : 'Setting up this Mac'}</Heading>
      {imageStageRows(image).map((row) => (
        <React.Fragment key={row.stage}>
          <Stage row={row} />
          {row.mark === 'now' && fraction !== null && <div className="runner-bar" role="progressbar" aria-label={row.label} aria-valuenow={Math.round(fraction * 100)}><b style={{ width: `${fraction * 100}%` }} /></div>}
        </React.Fragment>
      ))}
      {image.state === 'waiting' && <p role="status" className="runner-note warn">{image.detail}</p>}
      <Fine>
        {onResume
          ? 'Finished stages are kept, and a stopped download picks up where it left off.'
          : 'You can close this. Setup continues while Nekko runs, and a stopped download picks up where it left off.'}
      </Fine>
      <Alert error={error} />
      <Buttons>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onCancel}>Cancel setup</button>
        {onResume && <button type="button" className="btn btn-primary" disabled={busy} onClick={onResume}>Resume setup</button>}
      </Buttons>
    </Sheet>
  );
}

/** Frame 7. The sentence is the daemon's, as written; a refused Check lands here too, with nothing written yet. */
export function FailedStep({ image, error, busy, onCancel, onRetry }: { image: ImageView; error: string | null; busy: boolean; onCancel(): void; onRetry(): void }) {
  const [log, setLog] = useState(false);
  const rows = imageStageRows(image);
  const bad = rows.findIndex((r) => r.mark === 'bad');
  return (
    <Sheet>
      <Heading>Setup stopped</Heading>
      {rows.slice(Math.max(0, bad - 1), bad + 1).map((row) => <Stage key={row.stage} row={row} />)}
      <p role="alert" className="runner-note bad">{image.error}</p>
      {image.doneStages.length > 0 && (
        <Fine>{image.stage === 'lockdown' ? 'Finished stages are kept. Trying again goes back to the checkpoint and adds Xcode again.' : 'Finished stages are kept. Trying again restarts this stage only.'}</Fine>
      )}
      {log && image.log && <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-2xs text-ink-soft">{image.log}</pre>}
      <Alert error={error} />
      <Buttons>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onCancel}>Cancel setup</button>
        {image.log && <button type="button" className="btn btn-outline" onClick={() => setLog(!log)}>{log ? 'Hide log' : 'Show log'}</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onRetry}>Try again</button>
      </Buttons>
    </Sheet>
  );
}

export type SetupScreen = 'plan' | 'mode' | 'progress' | 'failed' | 'resume' | 'ready';

/** Which screen shows. The daemon owns the build, so a sheet opened at any moment lands on the right one. */
export function setupScreen({ image, rebuild, finished, needsMode }: { image: ImageView | null; rebuild: boolean; finished: boolean; needsMode: boolean }): SetupScreen {
  if (finished) return needsMode ? 'mode' : 'ready';
  if (image?.state === 'failed') return 'failed';
  if (image?.state === 'building' || image?.state === 'waiting') return 'progress';
  if (image?.canResume) return 'resume';
  return image?.state === 'ready' && !rebuild ? 'mode' : 'plan';
}

/** A rebuild names no runner: the job would otherwise turn it on and overwrite its mode. */
export function buildRequest(plan: ImagePlan | null | undefined, priority: Priority, runnerId: string, rebuild: boolean): ImageBuildRequest {
  return { kind: plan?.xcode === null ? 'macosOnly' : 'xcode', priority, ...(rebuild ? {} : { runnerId }) };
}

/** Mode-only setup: nothing to build, so this turns the runner on. The daemon refuses a public repo with its approval unsettled. */
export async function startRunner(
  id: string,
  priority: Priority,
  current: Priority,
  deps: { updateRunner(id: string, s: Partial<RunnerSettings>): Promise<RunnerView>; setRunnerEnabled(id: string, on: boolean): Promise<RunnerView> },
): Promise<RunnerView> {
  if (priority !== current) await deps.updateRunner(id, { priority });
  return deps.setRunnerEnabled(id, true);
}

/** The second step: mode, then the job in nekkod. It keeps running with this sheet closed. */
export function MacSetupSheet({ runnerId, view, image, rebuild, onClose, onWorkflow, beginReply }: {
  runnerId: string;
  view: RunnerView | undefined;
  image: ImageView | null;
  rebuild: boolean;
  onClose(): void;
  onWorkflow(): void;
  beginReply(): (v: RunnerView) => void;
}) {
  const current = view?.config.settings.priority ?? 'doNotDisturb';
  const [priority, setPriority] = useState<Priority>(current);
  const [plan, setPlan] = useState<ImagePlan | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    let live = true;
    void window.nekko.imagePlan().then((p) => { if (live) setPlan(p); }, () => { if (live) setPlan(null); });
    return () => { live = false; };
  }, []);

  // A build ends at rest, and so does a cancel: only the sheet can tell them apart.
  const building = image?.state === 'building' || image?.state === 'waiting';
  const wasBuilding = useRef(building);
  useEffect(() => {
    if (wasBuilding.current && image?.state === 'ready' && !cancelled.current) setFinished(true);
    wasBuilding.current = building;
  }, [building, image?.state]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!(await confirmDeletion('Delete this setup? What it has built so far is gone, and the download starts over. An image already in use is not touched.'))) return;
    cancelled.current = true;
    if (await act(() => window.nekko.cancelImage())) onClose();
    else cancelled.current = false;
  };
  const start = () => act(async () => {
    const reply = beginReply();
    reply(await startRunner(runnerId, priority, current, window.nekko));
    setFinished(true);
  });

  // A build only turns on the runner it names, so one connected during it still needs its mode.
  const needsMode = !rebuild && view !== undefined && !view.config.settings.enabled && !view.forkApprovalOpen;
  const screen = setupScreen({ image, rebuild, finished, needsMode });
  return (
    <Modal title="Set up this Mac" onClose={onClose} overlayClassName="p-4" className="card w-[460px] max-w-[94vw] max-h-[90vh] overflow-y-auto shadow-(--shadow-float)">
      {screen === 'plan' && (
        <PlanStep plan={plan} priority={priority} rebuild={rebuild} error={error} busy={busy} onPriority={setPriority} onBuild={() => void act(() => window.nekko.buildImage(buildRequest(plan, priority, runnerId, rebuild)))} />
      )}
      {screen === 'mode' && <ModeStep priority={priority} error={error} busy={busy} onPriority={setPriority} onStart={() => void start()} />}
      {screen === 'progress' && image && <ProgressStep image={image} error={error} busy={busy} onCancel={() => void cancel()} />}
      {screen === 'resume' && image && <ProgressStep image={image} error={error} busy={busy} onCancel={() => void cancel()} onResume={() => void act(() => window.nekko.resumeImage())} />}
      {screen === 'failed' && image && <FailedStep image={image} error={error} busy={busy} onCancel={() => void cancel()} onRetry={() => void act(() => window.nekko.resumeImage())} />}
      {screen === 'ready' && <RunnerReady on={view?.config.settings.enabled ?? false} forkOpen={view?.forkApprovalOpen ?? false} onDone={onClose} onWorkflow={onWorkflow} />}
    </Modal>
  );
}
