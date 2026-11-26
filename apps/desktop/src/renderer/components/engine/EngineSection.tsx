import { useDownloadAction } from './useDownloadAction.js';
import { EngineUpdateStatus } from './EngineUpdateStatus.js';
import { engineNotice, engineUpdateText, modelsNeedingNewerEngine } from './engineNotice.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadJob, EngineStatus, LocalModel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Toggle } from '../primitives/index.js';
import { CheckIcon, ChevronIcon, CopyIcon } from '../../icons.js';
import { SettingsIcon } from '../../gentleface-icons.js';
import { EngineInstallCard } from './EngineInstallCard.js';
import { ModelsHome, type ModelsMode } from './ModelsHome.js';
import { ResidentModels } from './ResidentModels.js';
import { ModelsModeSwitch } from './ModelsModeSwitch.js';
import { QuietTabs } from '../primitives/index.js';
import { DownloadsPanel } from './DownloadsPanel.js';
import { groupDownloads, isActive } from './downloadGroups.js';
import { EngineServerSettings } from './EngineServerSettings.js';
import { ModelFolders } from './ModelFolders.js';
import { prefersMlx } from './engineRows.js';
import { DecisionModels } from './DecisionModels.js';
import { ServerPowerSwitch } from '../server/ServerPowerSwitch.js';
import { ServiceLoadState } from '../ServiceLoadState.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { Shown } from '../ModeViews.js';

/**
 * The engine Nekko Agent runs itself, and the models it serves.
 *
 * These are one block rather than two because they are one thing: the server and
 * the models it can load are useless apart, and the questions people actually
 * arrive with ("is it running", "what have I got", "where did that come from",
 * "get me another one") interleave. Splitting them into a server card and a
 * model card made you cross the page to answer any of them.
 *
 * Five surfaces, which is exactly why this is a section and not a taller card:
 * the library, the catalog, the download queue, the folders that feed the
 * library, and the server's own configuration.
 */

/** Matches the runtime cards' poll, so the whole page moves at one rhythm. */
const POLL_MS = 6000;
const PROVIDER_ID = 'nekko-engine';

/** The two halves of the library, and the two panels that feed it. */
type Tab = ModelsMode | 'downloads' | 'folders';

export function EngineSection({
  onProvidersChanged,
  onOpenModel,
  refreshKey = 0,
}: {
  /** Changes when the Engines block above changed something this section shows. */
  refreshKey?: number;
  onProvidersChanged: () => void;
  /** Open one catalog model's own page, which the whole view takes over for. */
  onOpenModel: (id: string) => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Array<LocalModel & { loaded: boolean }>>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [tab, setTab] = useState<Tab | null>(null);
  // A jump to one model's settings lands on the models on this machine, wherever this page was left.
  const focus = useStore((s) => s.localModelFocus);
  useEffect(() => { if (focus) setTab('installed'); }, [focus]);
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  // Folded by default: the library below is what most visits are for.
  const [serverOpen, setServerOpen] = useState(false);
  const logRef = useRef<HTMLElement>(null);
  // A failed start opens Configure on the logs, so the reason is in view.
  const showLog = () => {
    setConfigOpen(true);
    requestAnimationFrame(() => logRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const runtimeDownload = useDownloadAction({ runtime: 'llama' });
  const repairing = runtimeDownload.active;

  const refresh = useCallback(async () => {
    const [s, m, d] = await Promise.allSettled([
      window.nekko.engineStatus().then((s) => {
        if (!s) throw new Error('Nekko service returned no model server status.');
        return s;
      }),
      window.nekko.engineModels().then((models) => {
        if (!Array.isArray(models)) throw new Error('Nekko service returned no model list.');
        return models;
      }),
      window.nekko.engineDownloads().then((jobs) => {
        if (!Array.isArray(jobs)) throw new Error('Nekko service returned no download list.');
        return jobs;
      }),
    ]);
    if (s.status === 'fulfilled') setStatus(s.value);
    if (m.status === 'fulfilled') setModels(m.value);
    if (d.status === 'fulfilled') setJobs(d.value);
    const failure = [s, m, d].find((result) => result.status === 'rejected');
    setError(failure?.status === 'rejected' ? (failure.reason instanceof Error ? failure.reason.message : 'Nekko service is unavailable.') : null);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, refreshKey]);

  // Progress arrives as events, so the panel stays live between polls; a finished
  // download also means a new model, hence the library refresh.
  useEffect(() => {
    return window.nekko.onDownloadsUpdated((next) => {
      setJobs(next);
      if (next.some((j) => j.state === 'done')) void refresh();
    });
  }, [refresh]);

  // A load in flight moves faster than the quiet poll: while any are, tick
  // quickly so the progress bar and the in-memory row feel live.
  const loadingCount = status?.loading?.length ?? 0;
  useEffect(() => {
    if (!loadingCount) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [loadingCount, refresh]);

  if (!status) return <ServiceLoadState label="model server" error={error} retry={refresh} />;
  // An empty machine opens on finding a model; one with models, on them.
  const shown: Tab = tab ?? (models.length ? 'installed' : 'find');
  const mode: ModelsMode = shown === 'find' || shown === 'downloads' ? 'find' : 'installed';

  const { install, running } = status;
  const installed = Boolean(install.binPath || status.diffusionInstall?.binPath);
  const needNewer = modelsNeedingNewerEngine(models);
  const notice = engineNotice(install, needNewer);
  // A model's weights, shards and helper files are one download, so the count is per model, not per file.
  const modelJobs = jobs.filter((job) => job.kind === 'model');
  const active = groupDownloads(modelJobs).filter((g) => isActive(g.state));
  const borrowed = models.filter((m) => m.managed === false).length;

  // One click puts a broken engine right: the same build, downloaded again into
  // a clean folder. The server is stopped by the host just before the swap.
  // The CUDA upgrade takes the same path: a different build, downloaded into
  // its own folder, swapped in when it lands. So does the update of an old
  // engine: the installed build again, at the pinned release.
  const reinstall = async (buildId: string | undefined, started: string) => {
    if (!buildId) return;
    const res = await runtimeDownload.run(() => window.nekko.engineInstall(buildId));
    if (!res) return;
    pushToast(res.ok ? 'info' : 'error', res.ok ? started : res.message);
    await refresh();
  };

  const toggle = async () => {
    setBusy(running ? 'stopping' : 'starting');
    const res = running
      ? await window.nekko.runtimeStop(PROVIDER_ID, true).catch((e: Error) => ({ ok: false, message: e.message }))
      : await window.nekko.runtimeStart(PROVIDER_ID).catch((e: Error) => ({ error: e.message }));
    setBusy(null);
    // `runtimeStart` answers with a status or an error; `runtimeStop` with ok +
    // a message. Both failure shapes end up in the same toast.
    const failure =
      'error' in res ? (res as { error: string }).error : 'ok' in res && !res.ok ? res.message : null;
    if (failure) {
      pushToast('error', failure);
      showLog();
    }
    await refresh();
    onProvidersChanged();
  };

  // Lives outside the settings accordion on purpose: it is part of "is the
  // server on", not part of its configuration, and a finished download flips
  // it on automatically.
  const saveAutoStart = async (on: boolean) => {
    try {
      await window.nekko.engineSettingsSave({ autoStart: on });
      await refresh();
    } catch (e) {
      pushToast('error', (e as Error).message);
    }
  };

  const address = `http://127.0.0.1:${status.settings.port}/v1`;

  return (
    <section className="min-w-0 space-y-8">
      {error && <ServiceLoadState label="model server" error={error} retry={refresh} />}
      {/* The agent server moved to Settings > Server: this page is about models. */}
      <div className="min-w-0">
      {/* The header is the server's whole state: the dot and the Serving
          switch say whether it is up, the address is what other apps point
          at, and Configure holds everything else. There used to be a
          "Running" row under it repeating the switch. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-model-server>
        <StatusDot running={running && installed} busy={busy !== null} />
        {/* The header stays: it is the server's state. Folded beneath it are the loaded models. */}
        <h2 className="text-base font-semibold">
          <button type="button" className="flex items-center gap-2" aria-expanded={serverOpen} onClick={() => setServerOpen((o) => !o)}>
            Model server
            <ChevronIcon className={`h-3.5 w-3.5 text-ink-faint transition-transform duration-150 ${serverOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
        </h2>
        {installed && running && <AddressPill address={address} />}
        {!serverOpen && status.resident.length > 0 && <span className="text-xs text-ink-faint">{status.resident.length} loaded</span>}
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <ServerPowerSwitch
            running={running}
            busy={busy !== null}
            unavailable={installed ? undefined : 'Not installed'}
            onToggle={() => void toggle()}
            labelWhat="model server"
          />
          <label
            className="flex items-center gap-2 text-xs text-ink-soft"
            title="Bring the engine up when the app opens"
          >
            Start Server on Nekko Launch
            <Toggle
              value={status.settings.autoStart}
              onChange={(v) => void saveAutoStart(v)}
              label="Start the model server with Nekko"
            />
          </label>
          <button
            type="button"
            className={`btn btn-ghost gap-2 text-xs ${configOpen ? 'text-accent' : ''}`}
            aria-expanded={configOpen}
            aria-controls="model-server-configure"
            title="Server settings and logs"
            data-icon-hover
            data-model-server-configure
            onClick={() => setConfigOpen((o) => !o)}
          >
            <SettingsIcon className="h-4 w-4" />
            Configure
          </button>
        </div>
      </div>

      {/* Server settings and logs: what you reach for when setting
          the server up or when a start fails, folded behind Configure. It
          opens itself when a start fails, on the logs. */}
      <div id="model-server-configure" className="library-fold" data-open={configOpen ? '' : undefined} inert={!configOpen}>
        <div>
          <div className="mt-(--q-group) space-y-(--q-group) border-t border-line pt-(--q-group)" data-model-server-config>
            <Shown id="engine">
              <section>
                <h3 className="quiet-group-label">Server</h3>
                <div className="mt-(--q-heading)">
                  <EngineServerSettings settings={status.settings} install={install} running={running} onChanged={() => { void refresh(); onProvidersChanged(); }} />
                </div>
              </section>
            </Shown>
            {/* The engine's own output: when a start fails this is where you look. */}
            <section ref={logRef}>
              <h3 className="quiet-group-label">Server logs</h3>
              {status.log.length > 0 ? (
                <pre className="mt-(--q-heading) max-h-40 overflow-auto rounded bg-[color-mix(in_srgb,var(--ink-faint)_8%,transparent)] p-2 font-mono text-2xs">
                  {status.log.join('\n')}
                </pre>
              ) : (
                <p className="mt-(--q-heading) text-xs text-ink-faint">Nothing logged yet.</p>
              )}
            </section>
          </div>
        </div>
      </div>

      <div className="mt-3 min-w-0">
        {/* The install card used to be the *whole* card until an engine existed,
            which hid the library behind it — so a machine with twenty models
            already on it showed "not installed" and nothing else. What we have is
            true whether or not the runtime is downloaded; only running it isn't. */}
        {!install.binPath && <EngineInstallCard install={install} onChanged={refresh} />}
      </div>

      <div className="min-w-0">
        {installed && (
          <>

            {notice === 'repair' && install.problem && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3"
                style={{ borderColor: 'var(--warning)' }}
              >
                <p className="min-w-0 flex-1 text-xs">{install.problem.message}</p>
                <button
                  className="btn btn-primary py-1 text-xs"
                  onClick={() => void reinstall(install.problem?.repairBuildId, 'Repairing the engine. Models will use your graphics card once it finishes.')}
                  disabled={repairing}
                >
                  {repairing ? 'Downloading…' : 'Repair engine'}
                </button>
              </div>
            )}

            {notice === 'switch' && install.upgrade && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
                <p className="min-w-0 flex-1 text-xs text-ink-soft">{install.upgrade.message}</p>
                <button
                  className="btn py-1 text-xs"
                  onClick={() => void reinstall(install.upgrade?.buildId, 'Downloading the CUDA engine. Nekko switches to it once it finishes.')}
                  disabled={repairing}
                >
                  {repairing ? 'Downloading…' : 'Switch to CUDA'}
                </button>
              </div>
            )}

            {notice === 'update' && install.outdated && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
                <p className="min-w-0 flex-1 text-xs text-ink-soft">{engineUpdateText(install.outdated, needNewer)}</p>
                <button
                  className="btn py-1 text-xs"
                  onClick={() => void reinstall(install.outdated?.buildId, 'Updating the engine. The server stops while it swaps in, so switch it back on once it finishes.')}
                  disabled={repairing}
                >
                  {repairing ? 'Downloading…' : 'Update'}
                </button>
              </div>
            )}

            {install.binPath && <EngineUpdateStatus download={runtimeDownload} onChanged={refresh} />}

            {status.settings.bind === 'lan' && running && (
              <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>
                Reachable from your whole network on port {status.settings.port}
                {status.settings.apiKey ? ', and a key is required.' : '. No key is set, so anything on it can use your models.'}
              </p>
            )}
          </>
        )}
      </div>
      </div>
      {/* What is running leads: "is it loaded, and how much does it hold" is
          the question a load click is really asking. */}
      {installed && serverOpen && (
        <ErrorBoundary label="Running models">
          <ResidentModels providerId={PROVIDER_ID} resident={status.resident} loading={status.loading} models={models} settings={status.settings} memory={status.memory} onChanged={refresh} />
        </ErrorBoundary>
      )}
      <div data-models-section="library" className="min-w-0 border-t border-line pt-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-base font-semibold">Models</h2>
          <ModelsModeSwitch
            value={shown === 'installed' || shown === 'find' ? shown : null}
            installedCount={models.length}
            onChange={setTab}
          />
          <QuietTabs<'downloads' | 'folders'>
            className="ml-auto"
            label="Downloads and folders"
            value={shown === 'downloads' || shown === 'folders' ? shown : null}
            onChange={setTab}
            items={[
              { value: 'downloads', label: 'Downloads', hint: active.length > 0 ? String(active.length) : undefined },
              { value: 'folders', label: 'Folders', hint: borrowed > 0 ? `${borrowed} borrowed` : undefined },
            ]}
          />
        </div>

        <div className="mt-(--q-group)">
          <ErrorBoundary key={shown} label="Model library">
          {(shown === 'installed' || shown === 'find') && (
            <ModelsHome
              providerId={PROVIDER_ID}
              mode={mode}
              models={models}
              canLoad={installed}
              memory={status.memory}
              resident={status.resident}
              settings={status.settings}
              running={running}
              onChanged={refresh}
              onOpenModel={onOpenModel}
              onFind={() => setTab('find')}
              mlx={Boolean(status.mlxInstall?.available.length)}
              preferMlx={prefersMlx(status)}
            />
          )}
          {shown === 'downloads' && <DownloadsPanel jobs={modelJobs} onChanged={refresh} />}
          {shown === 'folders' && <ModelFolders onChanged={refresh} />}
          </ErrorBoundary>
        </div>

        {shown === 'installed' && (
          <section data-decisions-subgroup className="mt-(--q-section)">
            <h3 className="text-sm font-semibold">Decision models</h3>
            <div className="mt-3">
              <ErrorBoundary label="Decision models">
                <DecisionModels />
              </ErrorBoundary>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

/** The address, one click from the clipboard: it is what other tools need. */
function AddressPill({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="inline-flex items-center gap-2 rounded-full border px-2 py-1 font-mono text-2xs text-ink-faint hover:text-ink"
      style={{ borderColor: 'var(--line)' }}
      title="Copy the address other tools should point at"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
        } catch {
          /* clipboard denied, nothing worth surfacing */
        }
      }}
    >
      {address}
      {copied ? (
        <span style={{ color: 'var(--success)' }}>
          <CheckIcon className="h-3 w-3" />
        </span>
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}

function StatusDot({ running, busy }: { running: boolean; busy: boolean }) {
  const color = busy ? 'var(--warning)' : running ? 'var(--accent)' : 'var(--ink-faint)';
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, opacity: busy ? 0.7 : 1 }}
      aria-hidden
    />
  );
}
