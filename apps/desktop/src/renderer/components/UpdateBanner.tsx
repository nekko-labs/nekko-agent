import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppInfo, UpdateInfo } from '@nekko-agent/shared';
import { useStore } from '../store.js';

const LS_LAST_VERSION = 'op_last_version';
const LS_SKIPPED_VERSION = 'nekko_skipped_update';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type UpdateStage =
  | 'unknown'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed';

type RetryAction = 'check' | 'download' | 'download-install' | 'install';

export interface UpdaterState {
  app: AppInfo | null;
  info: UpdateInfo | null;
  stage: UpdateStage;
  error: string | null;
  check: (force?: boolean) => Promise<void>;
  downloadOnly: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => void;
  retry: () => Promise<void>;
  dismissResult: () => void;
}

const UpdaterContext = createContext<UpdaterState | null>(null);

export function deriveUpdateStage({
  info,
  checking,
  installing,
  installed,
  skippedVersion,
  error,
}: {
  info: UpdateInfo | null;
  checking: boolean;
  installing: boolean;
  installed: string | null;
  skippedVersion: string | null;
  error: string | null;
}): UpdateStage {
  if (checking) return 'checking';
  if (installed) return 'installed';
  if (installing) return 'installing';
  if (info?.state === 'error' || error) return 'failed';
  if (info?.state === 'downloading') return 'downloading';
  if (info?.version && info.version !== skippedVersion) {
    if (info.state === 'downloaded') return 'downloaded';
    if (info.state === 'available') return 'available';
  }
  if (!info) return 'unknown';
  return 'idle';
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const settings = useStore((s) => s.settings);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [justUpdated, setJustUpdated] = useState<string | null>(null);
  const [skippedVersion, setSkippedVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction>('check');

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    window.nekko.getAppInfo().then((ai) => {
      if (!live) return;
      setAppInfo(ai);
      // "Updated to version X", current version differs from the last one we saw.
      const last = localStorage.getItem(LS_LAST_VERSION);
      if (last && last !== ai.version) setJustUpdated(ai.version);
      localStorage.setItem(LS_LAST_VERSION, ai.version);
      setSkippedVersion(localStorage.getItem(LS_SKIPPED_VERSION));
    });
    off = window.nekko.onUpdateEvent((next) => {
      setUpdate(next);
      setError(next.state === 'error' ? next.message ?? 'Update failed.' : null);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const check = useCallback(async (force = false) => {
    setRetryAction('check');
    setChecking(true);
    setError(null);
    if (force) {
      localStorage.removeItem(LS_SKIPPED_VERSION);
      setSkippedVersion(null);
    }
    const [next] = await Promise.all([
      window.nekko.checkForUpdates().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Update check failed.');
        return null;
      }),
      sleep(500),
    ]);
    if (next) {
      setUpdate(next);
      setError(next.state === 'error' ? next.message ?? 'Update check failed.' : null);
    }
    setChecking(false);
  }, []);

  // Once the user has opted into auto-update, do a check on load.
  useEffect(() => {
    if (settings?.autoUpdate) void check();
  }, [settings?.autoUpdate, check]);

  const install = useCallback(async () => {
    setRetryAction('install');
    setInstalling(true);
    setError(null);
    try {
      await window.nekko.quitAndInstall();
    } catch (cause) {
      setInstalling(false);
      setError(cause instanceof Error ? cause.message : 'The update could not be installed.');
    }
  }, []);

  const download = useCallback(async (installAfter: boolean) => {
    setRetryAction(installAfter ? 'download-install' : 'download');
    setError(null);
    const next = await window.nekko.downloadUpdate().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'The update could not be downloaded.');
      return null;
    });
    if (!next) return;
    setUpdate(next);
    if (next.state === 'error') {
      setError(next.message ?? 'The update could not be downloaded.');
      return;
    }
    if (installAfter && next.state === 'downloaded') {
      setInstalling(true);
      try {
        await window.nekko.quitAndInstall();
      } catch (cause) {
        setInstalling(false);
        setError(cause instanceof Error ? cause.message : 'The update could not be installed.');
      }
    }
  }, []);

  const downloadOnly = useCallback(() => download(false), [download]);
  const downloadAndInstall = useCallback(() => download(true), [download]);

  const skip = useCallback(() => {
    if (!update?.version) return;
    localStorage.setItem(LS_SKIPPED_VERSION, update.version);
    setSkippedVersion(update.version);
  }, [update?.version]);

  const retry = useCallback(async () => {
    if (retryAction === 'download') return downloadOnly();
    if (retryAction === 'download-install') return downloadAndInstall();
    if (retryAction === 'install') return install();
    return check(true);
  }, [retryAction, downloadOnly, downloadAndInstall, install, check]);

  const stage = deriveUpdateStage({
    info: update,
    checking,
    installing,
    installed: justUpdated,
    skippedVersion,
    error,
  });

  const value = useMemo<UpdaterState>(() => ({
    app: appInfo,
    info: update,
    stage,
    error,
    check,
    downloadOnly,
    downloadAndInstall,
    install,
    skip,
    retry,
    dismissResult: () => setJustUpdated(null),
  }), [appInfo, update, stage, error, check, downloadOnly, downloadAndInstall, install, skip, retry]);

  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}

export function useUpdater(): UpdaterState {
  const value = useContext(UpdaterContext);
  if (!value) throw new Error('useUpdater must be used inside UpdateProvider');
  return value;
}

function Spinner() {
  return (
    <svg className="update-spinner" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function UpdateProgress({ percent, installing = false }: { percent?: number; installing?: boolean }) {
  const known = !installing && percent != null;
  const value = known ? Math.max(0, Math.min(100, percent)) : undefined;
  return (
    <span
      className={`update-progress${known ? '' : ' update-progress-indeterminate'}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span className="update-progress-fill" style={known ? { transform: `scaleX(${Math.max(0.03, value! / 100)})` } : undefined} />
    </span>
  );
}

export function UpdateControl() {
  const updater = useUpdater();
  const [showDetails, setShowDetails] = useState(false);
  const { app, info, stage } = updater;
  if (!app || app.edition !== 'desktop') return null;

  const version = app.version;
  const target = info?.version ?? '';
  const wrap = (children: ReactNode, extra = '') => <span className={`titlebar-updater ${extra}`}>{children}</span>;

  if (stage === 'checking') {
    return wrap(<span className="update-pill update-busy" role="status" aria-live="polite"><Spinner /> Checking…</span>);
  }

  if (stage === 'downloading') {
    return wrap(
      <span className="update-pill update-busy update-progress-pill" role="status" aria-live="polite">
        <Spinner /> Downloading v{target}
        <UpdateProgress percent={info?.percent} />
        <b className="update-percent">{info?.percent ?? 0}%</b>
      </span>,
    );
  }

  if (stage === 'installing') {
    return wrap(
      <span className="update-pill update-busy update-progress-pill" role="status" aria-live="polite">
        <Spinner /> Installing v{target}
        <UpdateProgress installing />
        <span className="update-percent text-ink-faint">restarting</span>
      </span>,
    );
  }

  if (stage === 'installed') {
    return wrap(
      <button className="update-pill update-done" onClick={updater.dismissResult} title="Dismiss">
        ✓ Updated to v{version}
      </button>,
    );
  }

  if (stage === 'failed') {
    return wrap(
      <>
        <span className="update-pill update-failed" title={updater.error ?? 'Update failed'}>Update failed</span>
        <button className="title-update-action" onClick={() => void updater.retry()}>Retry</button>
        <button className="title-update-action title-update-secondary" onClick={() => setShowDetails((shown) => !shown)} aria-expanded={showDetails}>Details</button>
        {showDetails && <span className="update-error-detail" role="alert">{updater.error ?? 'The update failed. Try again or check the latest release.'}</span>}
      </>,
    );
  }

  if (stage === 'available' || stage === 'downloaded') {
    const ready = stage === 'downloaded';
    return wrap(
      <>
        <span className="update-offer-label" role="status" aria-label={`${ready ? 'Ready to install' : 'Update available'} v${target}`}>
          <span className="update-arrow" aria-hidden="true">↑</span>
          <span>{ready ? 'Ready to install' : 'Update available'}</span>
          <b>v{target}</b>
        </span>
        {ready ? (
          <button className="title-update-action title-update-primary" onClick={() => void updater.install()}>Install &amp; restart</button>
        ) : (
          <>
            <button className="title-update-action title-update-primary" onClick={() => void updater.downloadAndInstall()}>Download &amp; install</button>
            <button className="title-update-action" onClick={() => void updater.downloadOnly()}>Download only</button>
          </>
        )}
        <button className="title-update-action title-update-secondary" onClick={updater.skip}>Skip</button>
      </>,
      'titlebar-update-offer',
    );
  }

  const checked = info?.state === 'none' && !info.message;
  return wrap(
    <button
      className="update-pill update-version"
      onClick={() => void updater.check(true)}
      aria-label={`Check for updates. Current version ${version}${checked ? ', latest' : ''}.`}
      title={checked ? 'You are on the latest version. Click to check again.' : 'Check for updates'}
    >
      <span className="update-version-value">v{version}{checked && <span className="update-latest"> · latest</span>}</span>
      <span className="update-check-label">Check for updates</span>
    </button>,
  );
}

/**
 * Top-right update surface. Three jobs:
 *  1. First run (desktop): ask whether to auto-check for updates.
 *  2. When a newer version is available: offer an Update button.
 *  3. Right after updating: confirm the new version + link to the release notes.
 */
export function UpdateBanner() {
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const updater = useUpdater();
  const [busy, setBusy] = useState(false);
  const [dismissedFirstRun, setDismissedFirstRun] = useState(false);
  const { app: info, info: update } = updater;

  if (!info) return null;

  const isDesktop = info.edition === 'desktop';
  const notesUrl = update?.notesUrl ?? 'https://github.com/nekko-labs/nekko-agent/releases/latest';
  const openNotes = () => window.nekko.openPath(notesUrl);

  // First-run prompt (desktop only, the Local Web UI just refreshes).
  const showFirstRun =
    isDesktop && settings != null && !settings.autoUpdatePrompted && !dismissedFirstRun;

  const enableAuto = async () => {
    setBusy(true);
    await window.nekko.updateSettings({ autoUpdate: true, autoUpdatePrompted: true });
    await refreshSettings();
    setBusy(false);
  };
  const declineAuto = async () => {
    await window.nekko.updateSettings({ autoUpdatePrompted: true });
    await refreshSettings();
    setDismissedFirstRun(true);
  };

  const doUpdate = async () => {
    setBusy(true);
    if (!isDesktop) {
      await window.nekko.quitAndInstall(); // reloads the page
      return;
    }
    await updater.downloadAndInstall();
    setBusy(false);
  };

  const available = !isDesktop && update && (update.state === 'available' || update.state === 'downloading' || update.state === 'downloaded');

  return (
    <div className="pointer-events-none absolute right-4 top-12 z-50 flex w-80 flex-col gap-3">
      {showFirstRun && (
        <div className="card pointer-events-auto fade-in p-3 shadow-lg">
          <div className="text-[13px] font-semibold">Auto-check for updates?</div>
          <p className="mt-1 text-[11px] text-ink-faint">
            Periodically checks GitHub for new versions. <span className="italic">Note: connects to the internet.</span>
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <button className="btn btn-ghost px-2.5 py-1 text-[12px]" onClick={declineAuto}>No thanks</button>
            <button className="btn btn-primary px-2.5 py-1 text-[12px]" onClick={enableAuto} disabled={busy}>
              {busy ? 'Checking…' : 'Yes, check'}
            </button>
          </div>
        </div>
      )}

      {available && (
        <div className="card pointer-events-auto fade-in p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold">A new version is available</div>
            <button className="text-ink-faint hover:text-ink" onClick={updater.skip} aria-label="Skip this update">×</button>
          </div>
          {update.state === 'downloading' ? (
            <div className="mt-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                <div className="h-full rounded-full" style={{ width: `${update.percent ?? 0}%`, background: 'var(--accent)' }} />
              </div>
              <p className="mt-1 text-[11px] text-ink-faint">Downloading… {update.percent ?? 0}%</p>
            </div>
          ) : (
            <div className="mt-2.5 flex items-center justify-between">
              <button className="text-[12px] text-accent hover:underline" onClick={openNotes}>What's new</button>
              <button className="btn btn-primary px-2.5 py-1 text-[12px]" onClick={doUpdate} disabled={busy}>Refresh now</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
