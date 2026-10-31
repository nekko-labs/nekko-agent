import { useCallback, useEffect, useState } from 'react';
import {
  RUNTIME_CAPABILITIES,
  type ModelFacts,
  type ProviderConfig,
  type RuntimeKind,
  type RuntimeStatus,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { AddressField } from './AddressField.js';
import { FitDrawer } from './FitDrawer.js';
import { formatBytes } from './verdict.js';

/**
 * A local model server, as one card: is it on, where is it, what is it holding,
 * and what would it cost to load something else into it.
 *
 * Everything the card offers is gated on the runtime's declared capabilities
 * rather than its name, so vLLM's connect-existing shape needs no special case
 * here and a future bundled engine needs no change at all.
 */

const POLL_MS = 6000;

export function RuntimeCard({
  provider,
  kind,
  onChanged,
}: {
  provider: ProviderConfig;
  kind: RuntimeKind;
  onChanged: () => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [facts, setFacts] = useState<ModelFacts[]>([]);
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [openModel, setOpenModel] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const caps = RUNTIME_CAPABILITIES[kind];

  const refresh = useCallback(async () => {
    const [s, f] = await Promise.all([
      window.nekko.runtimeStatus(provider.id).catch(() => null),
      window.nekko.runtimeFacts(provider.id).catch(() => [] as ModelFacts[]),
    ]);
    setStatus(s);
    setFacts(f);
  }, [provider.id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const start = async () => {
    setBusy('starting');
    const res = await window.nekko.runtimeStart(provider.id).catch((e: Error) => ({ error: e.message }));
    setBusy(null);
    // RuntimeStatus carries an optional `error` of its own, so `'error' in res`
    // does not discriminate the union. A failure is the shape with no `kind`.
    if (res && !('kind' in res)) {
      pushToast('error', res.error);
      setShowLog(true);
    }
    refresh();
  };

  const stop = async (force = false) => {
    setBusy('stopping');
    const res = await window.nekko
      .runtimeStop(provider.id, force)
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setBusy(null);

    // We refuse to kill a process we did not start until the user says so. The
    // thing on that port might be a service something else depends on.
    if (!res.ok && 'needsConfirmation' in res && res.needsConfirmation) {
      const ok = window.confirm(
        `${res.message}\n\nStop the process listening on ${provider.baseUrl} anyway?`,
      );
      if (ok) return stop(true);
      return;
    }
    if (!res.ok) pushToast('error', res.message);
    refresh();
  };

  const running = Boolean(status?.running);
  const residentVram = (status?.resident ?? []).reduce((n, r) => n + (r.vramBytes ?? 0), 0);
  const residentTotal = (status?.resident ?? []).reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  const spilled = residentTotal > 0 && residentVram > 0 && residentTotal - residentVram > 64 * 1024 * 1024;

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center gap-2">
        <StatusDot running={running} busy={busy !== null} error={Boolean(status?.error)} />
        <span className="text-sm">{running ? 'Running' : 'Stopped'}</span>
        {status?.version && <span className="text-2xs text-ink-faint">v{status.version}</span>}
        {status?.owned && (
          <span className="text-2xs text-ink-faint" title="Nekko Agent started this server, so it will stop cleanly">
            started here
          </span>
        )}

        <div className="ml-auto">
          {caps.canStart && status?.installed === false && !running ? (
            <span
              className="rounded-full border px-2 py-0.5 text-2xs text-ink-faint"
              style={{ borderColor: 'var(--line)' }}
              title={status.reason}
            >
              Not installed
            </span>
          ) : caps.canStart ? (
            <button
              className="btn btn-outline py-1 text-xs"
              onClick={() => (running ? stop() : start())}
              disabled={busy !== null}
              title={running ? 'Stop this model server' : 'Start this model server'}
            >
              <PowerIcon className="mr-1 inline h-3.5 w-3.5" />
              {busy === 'starting' ? 'Starting…' : busy === 'stopping' ? 'Stopping…' : running ? 'Stop' : 'Start'}
            </button>
          ) : running && caps.canStop ? (
            <button
              className="btn btn-outline py-1 text-xs"
              onClick={() => stop()}
              disabled={busy !== null}
              style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}
            >
              {busy === 'stopping' ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <span
              className="rounded-full border px-2 py-0.5 text-2xs text-ink-faint"
              style={{ borderColor: 'var(--line)' }}
              title="This runtime is started outside Nekko Agent"
            >
              Connect only
            </span>
          )}
        </div>
      </div>

      <div className="mt-2">
        <AddressField provider={provider} onSaved={() => { onChanged(); refresh(); }} />
      </div>

      {status?.metrics && (
        <p className="mt-1 text-2xs text-ink-faint">
          {status.metrics.kvCacheUsagePct !== undefined && `KV cache ${status.metrics.kvCacheUsagePct.toFixed(0)}% used`}
          {status.metrics.requestsWaiting !== undefined && ` · ${status.metrics.requestsWaiting} queued`}
        </p>
      )}

      {status?.resident?.length ? (
        <div className="mt-2 space-y-1">
          {status.resident.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-2xs">
              <span className="truncate">{r.id}</span>
              {r.contextLength !== undefined && (
                <span className="text-ink-faint">{Math.round(r.contextLength / 1024)}k ctx</span>
              )}
              {r.vramBytes !== undefined && r.sizeBytes !== undefined && (
                <span
                  className="ml-auto text-ink-faint"
                  title={
                    r.sizeBytes > r.vramBytes
                      ? `${formatBytes(r.sizeBytes - r.vramBytes)} of this model is running on the CPU`
                      : 'Entirely on the GPU'
                  }
                >
                  {formatBytes(r.vramBytes)} on GPU
                  {r.sizeBytes > r.vramBytes ? ` · ${formatBytes(r.sizeBytes - r.vramBytes)} on CPU` : ''}
                </span>
              )}
            </div>
          ))}
          {spilled && (
            <p className="text-2xs" style={{ color: 'var(--warning, #d1a054)' }}>
              Part of what is loaded is running on the CPU, which is much slower than the GPU.
            </p>
          )}
        </div>
      ) : running ? (
        <p className="mt-2 text-2xs text-ink-faint">Nothing loaded into memory.</p>
      ) : null}

      {status?.log?.length && showLog ? (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-2xs text-ink-faint">Server output</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-[color-mix(in_srgb,var(--ink-faint)_8%,transparent)] p-2 font-mono text-2xs">
            {status.log.join('\n')}
          </pre>
        </details>
      ) : null}

      {facts.length > 0 && (
        <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
          <p className="text-2xs text-ink-faint">Check a model against this machine</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {facts.slice(0, 12).map((f) => (
              <button
                key={f.id}
                className="rounded-full border px-2 py-1 text-2xs hover:border-[var(--accent)]"
                style={{
                  borderColor: openModel === f.id ? 'var(--accent)' : 'var(--line)',
                }}
                onClick={() => setOpenModel(openModel === f.id ? null : f.id)}
              >
                {f.loaded ? '● ' : ''}
                {f.id}
              </button>
            ))}
          </div>
          {openModel && (
            <FitDrawer
              providerId={provider.id}
              facts={facts.find((f) => f.id === openModel)!}
              kind={kind}
              capabilities={caps}
              onLoaded={(err) => {
                if (err) pushToast('error', err);
                else pushToast('success', 'Model loaded.');
                refresh();
              }}
              onClose={() => setOpenModel(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ running, busy, error }: { running: boolean; busy: boolean; error: boolean }) {
  const color = error ? 'var(--danger)' : busy ? 'var(--warning, #d1a054)' : running ? 'var(--success)' : 'var(--ink-faint)';
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, opacity: busy ? 0.7 : 1 }}
      aria-hidden
    />
  );
}

/** Drawn here rather than pulled from the icon set, which has no power glyph. */
export function PowerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
      <path d="M12 3v9" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </svg>
  );
}
