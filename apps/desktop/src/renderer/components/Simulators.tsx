import React, { useEffect, useRef, useState } from 'react';
import type { BootedSimulator, SimulatorsState } from '@nekko-agent/shared';
import {
  SIMULATOR_AUTO_SHUTDOWN_CHOICES,
  simulatorDetail,
  simulatorDuration,
  simulatorIdleLabel,
  simulatorUsedLabel,
  simulatorsCpu,
  simulatorsForSession,
} from '@nekko-agent/shared';
import { ChevronIcon, PhoneIcon } from '../icons.js';
import { useStore } from '../store.js';
import { onSimulatorUsed, refreshSimulators, useSimulators } from '../simulators.js';
import { StatusDot } from './primitives/index.js';
import './simulators.css';

/**
 * Booted simulators on every surface that shows them (#2814):
 *
 *  - `SimulatorRows`: the Simulators group in the Hardware monitor and in the
 *    monitor chip's panel. One row per device: name, CPU, the chat that last
 *    used it or how long it has sat idle, Open (the chat and the device's
 *    window) and Shut down. Its header folds it; Auto shutdown sits under it.
 *  - `SimulatorChipSegment`: the phone glyph and count on the monitor chip.
 *  - `SimulatorSection`: the chat's Simulator panel, at the top of its Agent
 *    Monitor, with a live view of the screen.
 *  - `SimulatorStatus`: the line above the composer saying a simulator this
 *    chat uses is running, which opens the panel.
 *
 * Every one of them is absent while nothing applies (no device booted, or
 * none this chat used).
 */

const UNDO_MS = 8_000;
/** The live view's refresh while it is on screen. Each frame is one `simctl io screenshot`. */
const FRAME_MS = 1_500;

const cpuText = (pct: number) => (pct > 0 && pct < 1 ? '<1% CPU' : `${Math.round(pct)}% CPU`);

/** Shut a device down; iOS offers Undo (boot it again) for a few seconds. */
function useShutdown() {
  const [busy, setBusy] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const shutdown = async (d: BootedSimulator) => {
    setBusy(d.id);
    try {
      const r = await window.nekko.simulatorsShutdown!(d.id);
      if (r.canUndo) {
        setUndo({ id: d.id, name: d.name });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setUndo(null), UNDO_MS);
      }
    } catch (e) {
      useStore.getState().pushToast('error', String(e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(null);
      refreshSimulators();
    }
  };
  const restore = async () => {
    if (!undo) return;
    const { id } = undo;
    setUndo(null);
    try { await window.nekko.simulatorsBoot!(id); }
    catch (e) { useStore.getState().pushToast('error', String(e).replace(/^Error:\s*/, '')); }
    refreshSimulators();
  };
  return { busy, undo, shutdown, restore };
}

function openInSimulator(d: BootedSimulator) {
  window.nekko.simulatorsOpen?.(d.id).catch((e) => useStore.getState().pushToast('error', String(e).replace(/^Error:\s*/, '')));
}

/**
 * A row's Open: the chat that last used the device, and the device's own
 * window (DeviceHub, or Simulator before Xcode 27) on top of it. A device no
 * agent used opens its window only; a headless emulator opens its chat only.
 */
export function openSimulatorAndChat(d: BootedSimulator, openChat: (sessionId: string) => void) {
  if (d.lastUse) openChat(d.lastUse.sessionId);
  if (d.canOpen) openInSimulator(d);
}

const COLLAPSED_KEY = 'nekko.simulators.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}

/** The group's folded state, remembered across restarts (both surfaces share it). */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1'); } catch { /* private mode */ }
    return !c;
  });
  return [collapsed, toggle];
}

/** When idle simulators an agent used shut down by themselves (`simulatorAutoShutdownMinutes`). */
export function SimulatorAutoShutdown() {
  const minutes = useStore((s) => s.settings?.simulatorAutoShutdownMinutes) ?? 0;
  const change = (value: number) => {
    window.nekko.updateSettings({ simulatorAutoShutdownMinutes: value || null })
      .then(() => useStore.getState().refreshSettings())
      .catch(() => {});
  };
  return (
    <label className="mt-1 flex items-center justify-between gap-2 text-2xs text-ink-soft" title="Shut down simulators an agent used once no agent has touched them for this long and they are nearly idle" data-simulator-auto-shutdown>
      <span>Auto shutdown</span>
      <select className="input w-auto py-0.5 text-2xs" value={minutes} onChange={(e) => change(Number(e.target.value))}>
        {SIMULATOR_AUTO_SHUTDOWN_CHOICES.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
        {!SIMULATOR_AUTO_SHUTDOWN_CHOICES.some(([m]) => m === minutes) && <option value={minutes}>After {minutes} min</option>}
      </select>
    </label>
  );
}

/** The second line of a device's row: who used it, or how long it has idled, and how long it has been up. */
export function simulatorRowDetail(d: BootedSimulator, now: number): string {
  const idle = simulatorIdleLabel(d, now);
  const used = simulatorUsedLabel(d, now);
  return [cpuText(d.cpuPct), idle ?? used ?? simulatorDetail(d), `up ${simulatorDuration(d.upSecs * 1000)}`].filter(Boolean).join(' · ');
}

/**
 * The Simulators group: one row per booted device, then Auto shutdown.
 * Its header folds it to one line (count and CPU), remembered. Nothing at
 * all while none is booted.
 */
export function SimulatorRows({ state, dense = true, collapsed: collapsedProp }: { state?: SimulatorsState | null; dense?: boolean; collapsed?: boolean }) {
  const live = useSimulators();
  const s = state === undefined ? live : state;
  const { busy, undo, shutdown, restore } = useShutdown();
  const openChat = useStore((st) => st.openChatPane);
  const [collapsedSaved, toggle] = useCollapsed();
  const collapsed = collapsedProp ?? collapsedSaved;
  const devices = s?.devices ?? [];
  if (!devices.length && !undo) return null;
  const now = s?.sampledAt ?? Date.now();
  return (
    <section className="simulator-rows" data-simulator-rows data-collapsed={collapsed || undefined} aria-label="Simulators">
      <button type="button" className="simulator-group-head flex w-full min-w-0 items-baseline gap-1 text-left" aria-expanded={!collapsed} onClick={toggle} title={collapsed ? 'Show simulators' : 'Hide simulators'}>
        <ChevronIcon className="simulator-chevron h-3 w-3 shrink-0 self-center text-ink-faint" />
        <span className="quiet-group-label min-w-0 flex-1">Simulators</span>
        {devices.length > 0 && <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{devices.length} running · {cpuText(simulatorsCpu(s))}</span>}
      </button>
      {!collapsed && <div className="simulator-group-body">
      <ul className="mt-1">
        {devices.map((d) => {
          const idle = simulatorIdleLabel(d, now);
          return (
            <li key={d.id} className="group/sim flex min-w-0 items-center gap-2 rounded-lg py-1" data-simulator-row={d.id}>
              <PhoneIcon className="h-4 w-4 shrink-0 text-ink-soft" />
              <span className="flex min-w-0 flex-1 flex-col">
                {/* The CPU leads the detail line, so a narrow dock keeps the name whole. */}
                <span className={`min-w-0 truncate font-medium ${dense ? 'text-xs' : 'text-sm'}`} title={[d.name, simulatorDetail(d)].filter(Boolean).join(' · ')}>{d.name}</span>
                {d.lastUse && !idle
                  ? <button type="button" className="simulator-link min-w-0 truncate text-left text-2xs text-ink-faint hover:text-ink-soft" title={`${simulatorRowDetail(d, now)}. Open this chat`} onClick={() => openChat(d.lastUse!.sessionId)}>{simulatorRowDetail(d, now)}</button>
                  : <span className="min-w-0 truncate text-2xs text-ink-faint" title={simulatorRowDetail(d, now)} data-simulator-idle={idle ? '' : undefined}>{simulatorRowDetail(d, now)}</span>}
              </span>
              {/* Stacked, so a narrow panel keeps room for the name. */}
              <span className="simulator-row-actions flex shrink-0 flex-col items-end">
                {(d.canOpen || d.lastUse) && <button type="button" className="simulator-action text-2xs" style={{ color: 'var(--ink-soft)' }} onClick={() => openSimulatorAndChat(d, openChat)} title={openTitle(d)}>Open</button>}
                <button type="button" className="simulator-action text-2xs" style={{ color: 'var(--danger-text)' }} disabled={busy === d.id} onClick={() => void shutdown(d)} title={`Shut down ${d.name}`}>
                  {busy === d.id ? 'Stopping…' : 'Shut down'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {devices.length > 0 && <SimulatorAutoShutdown />}
      </div>}
      {undo && (
        <p className="mt-1 flex items-center gap-2 text-2xs text-ink-faint" role="status">
          <span className="min-w-0 flex-1 truncate">Shut down {undo.name}</span>
          <button type="button" className="text-accent hover:underline" onClick={() => void restore()}>Undo</button>
        </p>
      )}
    </section>
  );
}

/** The row's Open tooltip: what it will open. */
export function openTitle(d: BootedSimulator): string {
  const chat = d.lastUse ? `the chat using ${d.name}` : null;
  const win = d.canOpen ? `${d.name}'s window` : null;
  return `Open ${[chat, win].filter(Boolean).join(' and ')}`;
}

/** The monitor chip's phone glyph and count. Nothing while no device is booted. */
export function SimulatorChipSegment() {
  const s = useSimulators();
  const n = s?.devices.length ?? 0;
  if (!n) return null;
  return (
    <span className="flex items-center gap-1" data-simulator-chip title={`${n} simulator${n === 1 ? '' : 's'} running · ${cpuText(simulatorsCpu(s))}`}>
      <PhoneIcon className="h-3 w-3 text-ink-soft" />
      <span className="tabular-nums">{n}</span>
    </span>
  );
}

/** A device's screen, refreshed while it is on screen and the window is visible. */
function LiveScreen({ device }: { device: BootedSimulator }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let visible = true;
    const el = ref.current;
    const io = el && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; })
      : null;
    if (io && el) io.observe(el);
    const frame = async () => {
      if (stopped) return;
      if (visible && !document.hidden && window.nekko.simulatorsScreenshot) {
        try {
          const shot = await window.nekko.simulatorsScreenshot(device.id);
          if (!stopped) { setSrc(`data:${shot.mime};base64,${shot.data}`); setFailed(false); }
        } catch {
          if (!stopped) setFailed(true);
        }
      }
      if (!stopped) timer = setTimeout(frame, FRAME_MS);
    };
    void frame();
    return () => { stopped = true; if (timer) clearTimeout(timer); io?.disconnect(); };
  }, [device.id]);
  return (
    <div ref={ref} className="simulator-screen" data-simulator-screen>
      {src
        ? <img src={src} alt={`${device.name} screen`} className="block w-full rounded-[18px]" draggable={false} />
        : <div className="grid aspect-[9/19.5] w-full place-items-center rounded-[18px] text-2xs text-ink-faint" style={{ background: 'var(--surface-2)' }}>{failed ? 'No picture from this simulator' : 'Connecting…'}</div>}
    </div>
  );
}

/**
 * The chat's Simulator panel, at the top of its Agent Monitor: the devices
 * this chat's agent used that are still booted, with a live view of the
 * chosen one. Nothing while there are none.
 */
export function SimulatorSection({ sessionId, state }: { sessionId: string; state?: SimulatorsState | null }) {
  const live = useSimulators();
  const s = state === undefined ? live : state;
  const mine = simulatorsForSession(s, sessionId);
  const [chosen, setChosen] = useState<string | null>(null);
  const { busy, undo, shutdown, restore } = useShutdown();
  if (!mine.length && !undo) return null;
  const device = mine.find((d) => d.id === chosen) ?? mine[0];
  return (
    <section data-simulator-section aria-label="Simulator">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium text-ink-soft">Simulator</span>
        {device && <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{cpuText(device.cpuPct)}</span>}
      </div>
      {device && mine.length === 1 && (
        <p className="mb-2 truncate text-2xs text-ink-faint" title={[device.name, simulatorDetail(device)].filter(Boolean).join(' · ')}>{[device.name, simulatorDetail(device)].filter(Boolean).join(' · ')}</p>
      )}
      {mine.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Simulators this chat uses">
          {mine.map((d) => (
            <button key={d.id} type="button" role="tab" aria-selected={d.id === device?.id} className={`quiet-tab max-w-full truncate text-2xs ${d.id === device?.id ? 'text-ink' : 'text-ink-soft'}`} data-on={d.id === device?.id || undefined} onClick={() => setChosen(d.id)}>{d.name}</button>
          ))}
        </div>
      )}
      {device && (
        <>
          <LiveScreen key={device.id} device={device} />
          <div className="mt-2 flex items-center justify-end gap-1">
            {device.canOpen && <button type="button" className="btn btn-ghost px-2 text-2xs" onClick={() => openInSimulator(device)} title={`Show ${device.name} in its own window`}>Open window</button>}
            <button type="button" className="btn btn-ghost px-2 text-2xs" style={{ color: 'var(--danger-text)' }} disabled={busy === device.id} onClick={() => void shutdown(device)}>{busy === device.id ? 'Shutting down…' : 'Shut down'}</button>
          </div>
        </>
      )}
      {undo && (
        <p className="mt-1 flex items-center gap-2 text-2xs text-ink-faint" role="status">
          <span className="min-w-0 flex-1 truncate">Shut down {undo.name}</span>
          <button type="button" className="text-accent hover:underline" onClick={() => void restore()}>Undo</button>
        </p>
      )}
    </section>
  );
}

/**
 * Above the composer: a simulator this chat's agent used is running. Opens
 * the chat's Simulator panel, or Simulator itself when the chat has no room
 * for the panel.
 */
export function SimulatorStatus({ sessionId, onOpen, state }: { sessionId: string; onOpen: (device: BootedSimulator) => void; state?: SimulatorsState | null }) {
  const live = useSimulators();
  const mine = simulatorsForSession(state === undefined ? live : state, sessionId);
  if (!mine.length) return null;
  const first = mine[0];
  const label = mine.length === 1 ? `${first.name} is running` : `${mine.length} simulators are running`;
  return (
    <div className="flex items-center px-3 py-1" data-simulator-status>
      <button type="button" className="simulator-status flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-xs text-ink-soft" onClick={() => onOpen(first)} title="Show the simulator">
        <StatusDot tone="success" />
        <PhoneIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{cpuText(mine.reduce((n, d) => n + d.cpuPct, 0))}</span>
        <span className="shrink-0 text-2xs text-ink-faint">Show</span>
      </button>
    </div>
  );
}

const AUTO_OPENED_KEY = 'nekko.simulatorPanel.opened';

function autoOpened(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(AUTO_OPENED_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}

/** The key to remember when this use should open the chat's panel, or null when it should not. */
export function autoOpenKey(sessionId: string, used: { sessionId: string; deviceId: string }, seen: ReadonlySet<string>): string | null {
  if (used.sessionId !== sessionId) return null;
  const key = `${sessionId}:${used.deviceId}`;
  return seen.has(key) ? null : key;
}

function rememberAutoOpened(key: string) {
  const seen = [...autoOpened(), key].slice(-200);
  try { localStorage.setItem(AUTO_OPENED_KEY, JSON.stringify(seen)); } catch { /* private mode */ }
}

/**
 * Open this chat's Simulator panel (its Agent Monitor) the first time its
 * agent starts on a device, once per chat and device: closing the panel
 * keeps it closed until the agent moves to another device. Off with
 * `simulatorPanelAutoOpen: false`.
 */
export function useSimulatorAutoOpen(sessionId: string) {
  const enabled = useStore((s) => s.settings?.simulatorPanelAutoOpen !== false);
  // Subscribing keeps the sampler (and its `simulators:updated` listener) alive.
  useSimulators();
  useEffect(() => {
    if (!enabled) return;
    return onSimulatorUsed((used) => {
      const key = autoOpenKey(sessionId, used, autoOpened());
      if (!key) return;
      rememberAutoOpened(key);
      useStore.getState().setPlanRail(sessionId, true);
    });
  }, [enabled, sessionId]);
}
