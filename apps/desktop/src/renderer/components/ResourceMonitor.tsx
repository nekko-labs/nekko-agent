import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { GpuStats, MonitorKind, SystemStats } from '@nekko-agent/shared';
import { MONITOR_HINTS, MONITOR_KINDS, MONITOR_LABELS, gpuMemoryLabel, monitorSources, resolveMonitors } from '@nekko-agent/shared';
import { readBrandKey } from '../brandStorage.js';
import { useStore } from '../store.js';
import { ChevronIcon } from '../icons.js';
import { BackgroundChip, useBackgroundState } from './BackgroundChip.js';

/**
 * Resource monitoring: one sampler, two surfaces.
 *
 *  - `ResourceHud`, the always-on chip in the bottom-right corner, on every tab
 *    (a local model lives in VRAM, so these numbers matter everywhere). Hovering
 *    it reveals the per-monitor toggles and a device breakdown.
 *  - `ResourceDock`, the full monitoring section pinned to the foot of the chat's
 *    context panel. While it is on screen the chip warps into it instead of
 *    floating on top of it, so the two never overlap.
 *
 * Sampling follows the toggles: a monitor that is switched off is not polled, so
 * turning GPU and VRAM off really does stop spawning the GPU probe (`nvidia-smi`
 * on Windows and Linux, `ioreg` on macOS).
 */

const POLL_MS = 2000;

export interface ResourceSample {
  gpu: GpuStats | null;
  system: SystemStats | null;
}

/* ── The shared sampler ───────────────────────────────────────────────────────
   Module-level so the chip and the dock read the same readings from a single
   poll instead of probing the host twice per tick. */

let sample: ResourceSample = { gpu: null, system: null };
let sources = { system: false, gpu: false };
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(next: ResourceSample) {
  sample = next;
  for (const l of listeners) l();
}

function poll() {
  if (sources.system) {
    window.nekko.getSystemStats?.().then((s) => {
      if (sources.system) publish({ ...sample, system: s });
    }).catch(() => {});
  }
  if (sources.gpu) {
    window.nekko.getGpuStats?.().then((g) => {
      if (sources.gpu) publish({ ...sample, gpu: g });
    }).catch(() => {});
  }
}

function syncTimer() {
  const wanted = sources.system || sources.gpu;
  if (wanted && !timer) {
    poll();
    timer = setInterval(poll, POLL_MS);
  } else if (!wanted && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Point the sampler at exactly the probes the enabled monitors need. */
function setSources(next: { system: boolean; gpu: boolean }) {
  if (next.system === sources.system && next.gpu === sources.gpu) return;
  const started = { system: next.system && !sources.system, gpu: next.gpu && !sources.gpu };
  sources = next;
  // Drop readings for a source nobody watches, so a re-enabled monitor shows a
  // fresh number rather than a stale one from minutes ago.
  publish({
    system: next.system ? sample.system : null,
    gpu: next.gpu ? sample.gpu : null,
  });
  syncTimer();
  if (timer && (started.system || started.gpu)) poll();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    // Last surface unmounted: stop sampling entirely.
    if (listeners.size === 0) setSources({ system: false, gpu: false });
  };
}

/* ── Preferences ─────────────────────────────────────────────────────────── */

/** The user's monitor switches, filled out from the defaults. */
export function useMonitors(): Record<MonitorKind, boolean> {
  const prefs = useStore((s) => s.settings?.monitors);
  return useMemo(() => resolveMonitors(prefs), [prefs]);
}

/** Flip one monitor on/off (persisted; the sampler follows on the next render). */
function setMonitor(current: Record<MonitorKind, boolean>, kind: MonitorKind, on: boolean) {
  window.nekko.updateSettings({ monitors: { ...current, [kind]: on } })
    .then(() => useStore.getState().refreshSettings())
    .catch(() => {});
}

/**
 * Latest readings for the enabled monitors. Returns nulls for anything switched
 * off (and for a probe the host can't answer, e.g. a PC with no NVIDIA driver).
 */
export function useResourceSample(): ResourceSample {
  const ready = useStore((s) => s.settings !== null);
  const monitors = useMonitors();
  const need = monitorSources(monitors);
  const wantSystem = ready && need.system;
  const wantGpu = ready && need.gpu;
  useEffect(() => {
    setSources({ system: wantSystem, gpu: wantGpu });
  }, [wantSystem, wantGpu]);
  return useSyncExternalStore(subscribe, () => sample);
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

const GB = (mb: number) => (mb / 1024).toFixed(mb / 1024 >= 10 ? 0 : 1);
const pctOf = (used: number, total: number) => (total ? (used / total) * 100 : 0);
/** Load color, on the shared severity scale (quiet → warn → danger). */
const loadColor = (pct: number) => (pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--success)');

/** A labelled meter row: name, value, bar. The shared vocabulary of both surfaces. */
function Meter({ label, value, pct, sub }: { label: string; value: string; pct: number; sub?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-ink-soft">{label}</span>
        <span className="shrink-0 tabular-nums text-ink-faint">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          // A live-but-idle reading (1% CPU) still gets a visible sliver, so an
          // empty track always means "no data", never "nothing happening".
          style={{ width: `${Math.min(100, pct)}%`, minWidth: pct > 0 ? 3 : 0, background: loadColor(pct) }}
        />
      </div>
      {sub && <div className="mt-0.5 text-2xs tabular-nums text-ink-faint">{sub}</div>}
    </div>
  );
}

/* ── The dock: full monitoring section in the chat's context panel ────────── */

/**
 * The chat window's monitoring section: CPU load, memory use, and (when the host
 * can read a GPU) its utilization and memory, aggregate plus per device. Pinned
 * at the foot of the context panel so it stays put while the sources above
 * scroll.
 *
 * It publishes its own rectangle to the store, which is what lets the floating
 * chip warp into this section instead of covering it.
 */
const DOCK_OPEN_KEY = 'nekko.resourceDock.open';

export function ResourceDock({ standalone = false }: { standalone?: boolean } = {}) {
  const configured = useMonitors();
  const monitors = standalone ? { cpu: true, memory: true, gpu: true, vram: true } : configured;
  const { gpu, system } = useResourceSample();
  const setDockRect = useStore((s) => s.setMonitorDockRect);
  const ref = useRef<HTMLDivElement>(null);
  // Collapsible, because the meters are tall and the panel above them (folders,
  // file tree, context) is where the work happens.
  const [open, setOpen] = useState(() =>
    standalone || typeof window === 'undefined' ? true : readBrandKey(window.localStorage, DOCK_OPEN_KEY) !== 'off');
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { window.localStorage.setItem(DOCK_OPEN_KEY, next ? 'on' : 'off'); } catch { /* best effort */ }
    return next;
  });
  const anyOn = MONITOR_KINDS.some((k) => monitors[k]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (standalone || !el || !anyOn || !open) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      setDockRect({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      setDockRect(null);
    };
  }, [anyOn, open, standalone, setDockRect]);

  // Everything off: the chip takes over (it's the only way back on), so the
  // section stays out of the way entirely.
  if (!anyOn) return null;

  const vramPct = gpu ? pctOf(gpu.usedMB, gpu.totalMB) : 0;
  const gpuUtil = gpu ? Math.max(0, ...gpu.devices.map((d) => d.utilizationPct ?? 0)) : 0;
  // "VRAM" is a lie on Apple Silicon, where the GPU draws from the same pool as
  // the CPU, so the meter takes its name from what it is actually reading.
  const memLabel = gpuMemoryLabel(gpu);

  return (
    <div ref={ref} className={`monitor-absorb shrink-0 border-t border-line px-4 text-2xs ${open ? 'py-4' : 'py-2'}`}>
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={toggle}
        aria-expanded={open}
        title={open ? 'Collapse the resource meters' : 'Show the resource meters'}
      >
        <span className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
          Resources
          {gpu && (monitors.gpu || monitors.vram) && (
            <span className="chip text-2xs">{gpu.devices.length} GPU{gpu.devices.length === 1 ? '' : 's'}</span>
          )}
        </span>
        {/* Collapsed, the header still carries the numbers worth glancing at. */}
        <span className="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-ink-faint">
          {!open && monitors.cpu && system && <span>CPU {system.cpuPct}%</span>}
          {!open && monitors.vram && gpu && <span>{memLabel} {Math.round(pctOf(gpu.usedMB, gpu.totalMB))}%</span>}
          {open && 'live'}
        </span>
      </button>

      {!open ? null : (
      <>
      <div className="mt-2 space-y-2">
        {monitors.cpu && (
          <Meter
            label="CPU"
            value={system ? `${system.cpuPct}%` : '—'}
            pct={system?.cpuPct ?? 0}
            sub={system ? `${system.cpuCores} cores${system.cpuModel ? ` · ${system.cpuModel}` : ''}` : undefined}
          />
        )}
        {monitors.memory && (
          <Meter
            label="Memory"
            value={system ? `${Math.round(pctOf(system.memUsedMB, system.memTotalMB))}%` : '—'}
            pct={system ? pctOf(system.memUsedMB, system.memTotalMB) : 0}
            sub={system ? `${GB(system.memUsedMB)} / ${GB(system.memTotalMB)} GB used` : undefined}
          />
        )}
        {monitors.gpu && gpu && (
          <Meter label="GPU" value={`${gpuUtil}%`} pct={gpuUtil} sub="utilization" />
        )}
        {monitors.vram && gpu && (
          <Meter
            label={memLabel}
            value={`${Math.round(vramPct)}%`}
            pct={vramPct}
            sub={`${GB(gpu.usedMB)} / ${GB(gpu.totalMB)} GB used${gpu.unified ? ' · unified with system RAM' : ''}`}
          />
        )}
      </div>

      {monitors.vram && gpu && gpu.devices.length > 0 && (
        <div className="mt-2 max-h-32 space-y-2 overflow-y-auto border-t border-line pt-2">
          {gpu.devices.map((d, i) => {
            const dp = pctOf(d.memoryUsedMB, d.memoryTotalMB);
            return (
              <div key={i}>
                <div className="flex items-center justify-between text-2xs text-ink-faint">
                  <span className="min-w-0 truncate" title={d.name}>{d.name}</span>
                  {d.utilizationPct != null && <span className="shrink-0 tabular-nums">{d.utilizationPct}% util</span>}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                  <span className="block h-full rounded-full" style={{ width: `${dp}%`, background: loadColor(dp) }} />
                </div>
                <div className="mt-0.5 flex justify-between text-2xs tabular-nums text-ink-faint">
                  <span>{GB(d.memoryUsedMB)} GB used</span>
                  <span>{GB(d.memoryFreeMB)} GB free</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(monitors.gpu || monitors.vram) && !gpu && (
        <p className="mt-2 text-2xs text-ink-faint">No GPU stats available on this machine.</p>
      )}
      {/* Name the probes, so a number can be checked against the tool it came from. */}
      <p className="mt-2 text-right text-2xs text-ink-faint">
        {(monitors.gpu || monitors.vram) && gpu ? `os + ${gpu.source}` : 'os'}
      </p>
      </>
      )}
    </div>
  );
}

/* ── The chip: floating monitor, everywhere ──────────────────────────────── */

/**
 * The floating resource chip, pinned bottom-right on every tab. Collapsed it is a
 * quiet pill with one segment per enabled monitor; hovering (or clicking) opens
 * the panel where each monitor can be switched off, which also stops its polling.
 *
 * When the chat's `ResourceDock` is on screen the chip flies into it and fades
 * out, so the same numbers are never shown twice on top of each other. It flies
 * back when the dock leaves.
 */
export function ResourceHud() {
  const monitors = useMonitors();
  const { gpu, system } = useResourceSample();
  const background = useBackgroundState();
  const dock = useStore((s) => s.monitorDockRect);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [warp, setWarp] = useState<{ dx: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!dock) {
      setWarp(null);
      return;
    }
    // Offsets, not getBoundingClientRect: the chip may already be mid-flight, and
    // a measured rect would include its own transform and compound the offset.
    // offsetLeft/offsetTop are layout-only, so the origin is always where the chip
    // rests (it is `position: fixed`, so these are viewport coordinates).
    const cx = el.offsetLeft + el.offsetWidth / 2;
    const cy = el.offsetTop + el.offsetHeight / 2;
    setWarp({ dx: dock.x + dock.w / 2 - cx, dy: dock.y + dock.h / 2 - cy });
  }, [dock]);

  // The panel would hang in mid-air mid-flight.
  useEffect(() => {
    if (warp) setOpen(false);
  }, [warp]);

  const anyOn = MONITOR_KINDS.some((k) => monitors[k]);
  const memPct = system ? Math.round(pctOf(system.memUsedMB, system.memTotalMB)) : null;
  const gpuUtil = gpu ? Math.max(0, ...gpu.devices.map((d) => d.utilizationPct ?? 0)) : null;
  const vramPct = gpu ? pctOf(gpu.usedMB, gpu.totalMB) : 0;
  const memLabel = gpuMemoryLabel(gpu);

  return (
    <div
      ref={ref}
      className="monitor-chip fixed bottom-20 right-4 z-30 md:bottom-4"
      style={{
        transform: warp ? `translate(${warp.dx}px, ${warp.dy}px) scale(0.34)` : undefined,
        opacity: warp ? 0 : 1,
        filter: warp ? 'blur(3px)' : undefined,
        // `visibility` is in the transition too, so it flips only once the flight
        // finishes: the chip stays paintable on the way out, then leaves the tab
        // order and the a11y tree entirely while the dock owns these numbers.
        visibility: warp ? 'hidden' : 'visible',
        pointerEvents: warp ? 'none' : undefined,
      }}
      aria-hidden={warp ? true : undefined}
      onMouseEnter={() => !warp && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {open && (
        <div
          className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-line p-3 text-2xs"
          style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-md)' }}
        >
          <div className="mb-2 flex items-center justify-between font-semibold text-ink">
            <span>Monitors</span>
            <span className="font-normal text-ink-faint">off = not sampled</span>
          </div>
          <div role="group" aria-label="Resource monitors" className="space-y-0.5">
            {MONITOR_KINDS.map((kind) => (
              <button
                key={kind}
                role="switch"
                aria-checked={monitors[kind]}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-2"
                title={MONITOR_HINTS[kind]}
                onClick={() => setMonitor(monitors, kind, !monitors[kind])}
              >
                <span
                  className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border text-2xs font-bold"
                  style={
                    monitors[kind]
                      ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--surface)' }
                      : { borderColor: 'var(--line)', color: 'transparent' }
                  }
                >
                  ✓
                </span>
                <span className={`min-w-0 flex-1 ${monitors[kind] ? 'text-ink-soft' : 'text-ink-faint'}`}>
                  {kind === 'vram' ? memLabel : MONITOR_LABELS[kind]}
                </span>
                <span className="shrink-0 tabular-nums text-ink-faint">
                  {!monitors[kind] ? 'off'
                    : kind === 'cpu' ? (system ? `${system.cpuPct}%` : '—')
                    : kind === 'memory' ? (memPct != null ? `${memPct}%` : '—')
                    : kind === 'gpu' ? (gpuUtil != null ? `${gpuUtil}%` : '—')
                    : gpu ? `${GB(gpu.usedMB)}/${GB(gpu.totalMB)} GB` : '—'}
                </span>
              </button>
            ))}
          </div>
          {(monitors.gpu || monitors.vram) && gpu && (
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              {gpu.devices.map((d, i) => {
                const dp = pctOf(d.memoryUsedMB, d.memoryTotalMB);
                return (
                  <div key={i}>
                    <div className="flex justify-between">
                      <span className="min-w-0 truncate text-ink-soft" title={d.name}>{d.name}</span>
                      {d.utilizationPct != null && <span className="shrink-0 tabular-nums text-ink-faint">{d.utilizationPct}% util</span>}
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                      <span className="block h-full rounded-full" style={{ width: `${dp}%`, background: loadColor(dp) }} />
                    </div>
                    <div className="mt-0.5 flex justify-between tabular-nums text-ink-faint">
                      <span>{GB(d.memoryUsedMB)} GB used</span>
                      <span>{GB(d.memoryFreeMB)} GB free</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {(monitors.gpu || monitors.vram) && !gpu && (
            <p className="mt-2 border-t border-line pt-2 text-ink-faint">No GPU stats available on this machine.</p>
          )}
        </div>
      )}

      <button
        className="flex items-center gap-2 rounded-full border border-line px-3 py-1 text-2xs tabular-nums text-ink-faint"
        style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-sm)' }}
        aria-label="Resource monitors"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <BackgroundChip state={background} compact />
        {!anyOn && <span className="text-ink-faint">Monitors off</span>}
        {monitors.cpu && (
          <span className="flex items-center gap-1">
            <span className="font-semibold text-ink-soft">CPU</span>
            {system ? `${system.cpuPct}%` : '—'}
          </span>
        )}
        {monitors.memory && (
          <span className="flex items-center gap-1">
            <span className="font-semibold text-ink-soft">RAM</span>
            {memPct != null ? `${memPct}%` : '—'}
          </span>
        )}
        {monitors.gpu && (
          <span className="flex items-center gap-1">
            <span className="font-semibold text-ink-soft">GPU</span>
            {gpuUtil != null ? `${gpuUtil}%` : '—'}
          </span>
        )}
        {monitors.vram && (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-10 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
              <span
                className="block h-full rounded-full transition-[width] duration-500"
                style={{ width: `${vramPct}%`, background: loadColor(vramPct) }}
              />
            </span>
            {gpu ? `${GB(gpu.usedMB)}/${GB(gpu.totalMB)} GB` : '—'}
          </span>
        )}
      </button>
    </div>
  );
}
