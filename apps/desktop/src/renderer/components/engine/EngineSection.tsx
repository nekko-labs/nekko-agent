import { useCallback, useEffect, useState } from 'react';
import type { DownloadJob, EngineStatus, LocalModel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { Toggle } from '../primitives/index.js';
import { CheckIcon, CopyIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { EngineInstallCard } from './EngineInstallCard.js';
import { ModelsHome } from './ModelsHome.js';
import { DownloadsPanel } from './DownloadsPanel.js';
import { groupDownloads, isActive } from './downloadGroups.js';
import { EngineServerSettings } from './EngineServerSettings.js';
import { ModelFolders } from './ModelFolders.js';
import { DiffusionInstallCard } from './DiffusionInstallCard.js';
import { MlxInstallCard } from './MlxInstallCard.js';
import { DecisionModels } from './DecisionModels.js';
import { LocalServerSection } from '../server/LocalServerSection.js';
import { ServerPowerPill } from '../server/ServerPowerPill.js';

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

type Tab = 'models' | 'downloads' | 'folders' | 'decisions';

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
  const [models, setModels] = useState<Array<LocalModel & { loaded: boolean }>>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [tab, setTab] = useState<Tab>('models');
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const refresh = useCallback(async () => {
    const [s, m, d] = await Promise.all([
      window.nekko.engineStatus().catch(() => null),
      window.nekko.engineModels().catch(() => []),
      window.nekko.engineDownloads().catch(() => []),
    ]);
    setStatus(s);
    setModels(m);
    setJobs(d);
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

  if (!status) return null;

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
    setRepairing(true);
    const res = await window.nekko
      .engineInstall(buildId)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setRepairing(false);
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
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
        <h2 className="text-[15px] font-semibold">Model server</h2>
        <div className="ml-auto flex items-center gap-3">
          <ServerPowerPill
            running={running}
            busy={busy !== null}
            unavailable={installed ? undefined : 'Not installed'}
            onToggle={() => void toggle()}
            labelWhat="model server"
            color="var(--accent)"
          />
          <label
            className="flex items-center gap-1.5 text-[12px] text-ink-soft"
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
      <p className="mt-0.5 text-[12px] text-ink-faint">
        Serve text and image models on one address, using managed runtimes or models already on this machine.
      </p>

      <div className="card mt-3 p-5">
        {/* The install card used to be the *whole* card until an engine existed,
            which hid the library behind it — so a machine with twenty models
            already on it showed "not installed" and nothing else. What we have is
            true whether or not the runtime is downloaded; only running it isn't. */}
        {!install.binPath && <EngineInstallCard install={install} onChanged={refresh} />}
        {installed && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot running={running} busy={busy !== null} />
              <span className="text-[13px]">{running ? 'Running' : 'Stopped'}</span>
              {install.version && <span className="text-[11px] text-ink-faint">{install.version}</span>}
              {running && (
                <span className="text-[11px] text-ink-faint">
                  {status.resident.length} loaded
                  {residentBytes > 0 ? ` · ${formatBytes(residentBytes)} on GPU` : ''}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {running && <AddressPill address={address} />}
              </div>
            </div>

            {install.problem && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3"
                style={{ borderColor: 'var(--warning, #d1a054)' }}
              >
                <p className="min-w-0 flex-1 text-[12.5px]">{install.problem.message}</p>
                <button
                  className="btn btn-primary py-1.5 text-[12px]"
                  onClick={() => void reinstall(install.problem?.repairBuildId, 'Repairing the engine. Models will use your graphics card once it finishes.')}
                  disabled={repairing || active.some((g) => g.jobs.some((j) => j.kind === 'engine'))}
                >
                  {repairing ? 'Starting…' : 'Repair engine'}
                </button>
              </div>
            )}

            {install.upgrade && !install.problem && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--line)' }}>
                <p className="min-w-0 flex-1 text-[12.5px] text-ink-soft">{install.upgrade.message}</p>
                <button
                  className="btn py-1.5 text-[12px]"
                  onClick={() => void reinstall(install.upgrade?.buildId, 'Downloading the CUDA engine. Nekko switches to it once it finishes.')}
                  disabled={repairing || active.some((g) => g.jobs.some((j) => j.kind === 'engine'))}
                >
                  {repairing ? 'Starting…' : 'Switch to CUDA'}
                </button>
              </div>
            )}

            {status.settings.bind === 'lan' && running && (
              <p className="mt-2 text-[11.5px]" style={{ color: 'var(--warning, #d1a054)' }}>
                Reachable from your whole network on port {status.settings.port}
                {status.settings.apiKey ? ', and a key is required.' : '. No key is set, so anything on it can use your models.'}
              </p>
            )}
          </>
        )}

        <details className="mt-4 border-t border-line pt-4">
          <summary className="cursor-pointer text-[12px] font-medium">Model server settings</summary>
          <div className="mt-3"><EngineServerSettings settings={status.settings} install={install} running={running} onChanged={() => { void refresh(); onProvidersChanged(); }} /></div>
        </details>
        <DiffusionInstallCard install={status.diffusionInstall} onChanged={refresh} />
        <MlxInstallCard install={status.mlxInstall} onChanged={refresh} />

        {/* The engine's own output, under the server it came from rather than
            the model library: when a start fails this is where you look, and
            it opens itself (showLog) so you do not have to. */}
        {status.log.length > 0 && (
          <details className="mt-3" open={showLog}>
            <summary className="cursor-pointer text-[11px] text-ink-faint">Server logs</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-[color-mix(in_srgb,var(--ink-faint)_8%,transparent)] p-2 font-mono text-[10px]">
              {status.log.join('\n')}
            </pre>
          </details>
        )}
      </div>
      </div>
      <LocalServerSection />
      </div>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold">Models</h2>
        <p className="mt-0.5 text-[12px] text-ink-faint">Find, download and run models from one library.</p>
        <div className="card mt-3 min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap gap-1.5 border-b pb-2" style={{ borderColor: 'var(--line)' }}>
          <TabButton active={tab === 'models'} onClick={() => setTab('models')}>
            Models{models.length > 0 ? ` (${models.length})` : ''}
          </TabButton>
          <TabButton active={tab === 'downloads'} onClick={() => setTab('downloads')}>
            Downloads{active.length > 0 ? ` (${active.length})` : ''}
          </TabButton>
          <TabButton active={tab === 'folders'} onClick={() => setTab('folders')}>
            Folders{borrowed > 0 ? ` (${borrowed} borrowed)` : ''}
          </TabButton>
          <TabButton active={tab === 'decisions'} onClick={() => setTab('decisions')}>
            Decisions
          </TabButton>
        </div>

        <div className="mt-3">
          {tab === 'models' && (
            <ModelsHome
              providerId={PROVIDER_ID}
              models={models}
              canLoad={installed}
              memory={status.memory}
              resident={status.resident}
              loading={status.loading}
              settings={status.settings}
              running={running}
              onChanged={refresh}
              onOpenModel={onOpenModel}
              mlx={Boolean(status.mlxInstall?.available.length)}
            />
          )}
          {tab === 'downloads' && <DownloadsPanel jobs={jobs} onChanged={refresh} />}
          {tab === 'folders' && <ModelFolders onChanged={refresh} />}
          {tab === 'decisions' && <DecisionModels />}
        </div>
      </div>
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="rounded-full px-2.5 py-1 text-[12px]"
      style={
        active
          ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }
          : { color: 'var(--ink-faint)' }
      }
      onClick={onClick}
    >
      {children}
    </button>
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
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[11px] text-ink-faint hover:text-ink"
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
  const color = busy ? 'var(--warning, #d1a054)' : running ? 'var(--accent)' : 'var(--ink-faint)';
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, opacity: busy ? 0.7 : 1 }}
      aria-hidden
    />
  );
}
