import { useDownloadAction } from './useDownloadAction.js';
import { DownloadProgress } from './DownloadProgress.js';
import { useCallback, useEffect, useState } from 'react';
import type { DownloadJob, EngineStatus, LocalModel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Toggle } from '../primitives/index.js';
import { CheckIcon, CopyIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { EngineInstallCard } from './EngineInstallCard.js';
import { ModelsHome, type ModelsMode } from './ModelsHome.js';
import { ResidentModels } from './ResidentModels.js';
import { ModelsModeSwitch } from './ModelsModeSwitch.js';
import { QuietTabs } from '../primitives/index.js';
import { DownloadsPanel } from './DownloadsPanel.js';
import { groupDownloads, isActive } from './downloadGroups.js';
import { EngineServerSettings } from './EngineServerSettings.js';
import { ModelFolders } from './ModelFolders.js';
import { DiffusionInstallCard } from './DiffusionInstallCard.js';
import { MlxInstallCard } from './MlxInstallCard.js';
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
}: {
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
  const [showLog, setShowLog] = useState(false);
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
  }, [refresh]);

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
  // A model's weights, shards and helper files are one download, so the count is per model, not per file.
  const active = groupDownloads(jobs).filter((g) => isActive(g.state));
  const residentBytes = status.resident.reduce((n, r) => n + (r.vramBytes ?? 0), 0);
  const borrowed = models.filter((m) => m.managed === false).length;

  // One click puts a broken engine right: the same build, downloaded again into
  // a clean folder. The server is stopped by the host just before the swap.
  // The CUDA upgrade takes the same path: a different build, downloaded into
  // its own folder, swapped in when it lands.
  const reinstall = async (buildId: string | undefined, started: string) => {
    if (!buildId) return;
    const res = await runtimeDownload.run(() => window.nekko.engineInstall(buildId));
    if (!res) return;
    pushToast(res.ok ? 'info' : 'error', res.ok ? started : res.message);
    if (res.ok) setTab('downloads');
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
      setShowLog(true);
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
        <h2 className="text-base font-semibold">Model server</h2>
        <div className="ml-auto flex items-center gap-3">
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
        </div>
      </div>
      <p className="mt-0.5 text-xs text-ink-faint">
        Serve text and image models on one address, using managed runtimes or models already on this machine.
      </p>

      <div className="mt-3 min-w-0">
        {/* The install card used to be the *whole* card until an engine existed,
            which hid the library behind it — so a machine with twenty models
            already on it showed "not installed" and nothing else. What we have is
            true whether or not the runtime is downloaded; only running it isn't. */}
        {!install.binPath && <EngineInstallCard install={install} onChanged={refresh} />}
        {installed && (
          <div className="flex min-h-7 flex-wrap items-center gap-2">
            <StatusDot running={running} busy={busy !== null} />
            <span className="text-sm">{running ? 'Running' : 'Stopped'}</span>
            {install.version && <span className="text-2xs text-ink-faint">{install.version}</span>}
            {running && (
              <span className="text-2xs text-ink-faint">
                {status.resident.length} loaded
                {residentBytes > 0 ? ` · ${formatBytes(residentBytes)} on GPU` : ''}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {running && <AddressPill address={address} />}
            </div>
          </div>
        )}
      </div>

      <div className="min-w-0">
        {installed && (
          <>

            {install.problem && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3"
                style={{ borderColor: 'var(--warning)' }}
              >
                <p className="min-w-0 flex-1 text-xs">{install.problem.message}</p>
                <button
                  className="btn btn-primary py-1 text-xs"
                  onClick={() => void reinstall(install.problem?.repairBuildId, 'Repairing the engine. Models will use your graphics card once it finishes.')}
                  disabled={repairing || active.some((g) => g.jobs.some((j) => j.kind === 'engine'))}
                >
                  {repairing ? 'Downloading…' : 'Repair engine'}
                </button>
              </div>
            )}

            {install.upgrade && !install.problem && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
                <p className="min-w-0 flex-1 text-xs text-ink-soft">{install.upgrade.message}</p>
                <button
                  className="btn py-1 text-xs"
                  onClick={() => void reinstall(install.upgrade?.buildId, 'Downloading the CUDA engine. Nekko switches to it once it finishes.')}
                  disabled={repairing || active.some((g) => g.jobs.some((j) => j.kind === 'engine'))}
                >
                  {repairing ? 'Downloading…' : 'Switch to CUDA'}
                </button>
              </div>
            )}

            {repairing && <DownloadProgress group={runtimeDownload.group} />}

            {status.settings.bind === 'lan' && running && (
              <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>
                Reachable from your whole network on port {status.settings.port}
                {status.settings.apiKey ? ', and a key is required.' : '. No key is set, so anything on it can use your models.'}
              </p>
            )}
          </>
        )}

        <Shown id="engine"><details className="mt-4 border-t border-line pt-4">
          <summary className="cursor-pointer text-xs font-medium">Model server settings</summary>
          <div className="mt-3"><EngineServerSettings settings={status.settings} install={install} running={running} onChanged={() => { void refresh(); onProvidersChanged(); }} /></div>
        </details></Shown>
        {/* Which image and MLX runtimes are installed matters to few people, so
            it folds away like the server settings. The first card's divider
            would sit right under the summary, so it goes. */}
        <details className="mt-4 border-t border-line pt-4">
          <summary className="cursor-pointer text-xs font-medium">Runtimes</summary>
          <div className="[&>div:first-child]:mt-3 [&>div:first-child]:border-t-0 [&>div:first-child]:pt-0">
            <ErrorBoundary label="Image runtime"><DiffusionInstallCard install={status.diffusionInstall} onChanged={refresh} /></ErrorBoundary>
            <ErrorBoundary label="MLX runtime"><MlxInstallCard install={status.mlxInstall} onChanged={refresh} /></ErrorBoundary>
          </div>
        </details>

        {/* The engine's own output, under the server it came from rather than
            the model library: when a start fails this is where you look, and
            it opens itself (showLog) so you do not have to. */}
        {status.log.length > 0 && (
          <details className="mt-3" open={showLog}>
            <summary className="cursor-pointer text-2xs text-ink-faint">Server logs</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-[color-mix(in_srgb,var(--ink-faint)_8%,transparent)] p-2 font-mono text-2xs">
              {status.log.join('\n')}
            </pre>
          </details>
        )}
      </div>
      </div>
      {/* What is running leads: "is it loaded, and how much does it hold" is
          the question a load click is really asking. */}
      {installed && (
        <ErrorBoundary label="Running models">
          <ResidentModels providerId={PROVIDER_ID} resident={status.resident} loading={status.loading} models={models} settings={status.settings} memory={status.memory} onChanged={refresh} />
        </ErrorBoundary>
      )}
      <div data-models-section="library" className="min-w-0">
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
            />
          )}
          {shown === 'downloads' && <DownloadsPanel jobs={jobs} onChanged={refresh} />}
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
