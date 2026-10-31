import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { formatTemperature, temperatureTone } from '@nekko-agent/shared';
import { GaugeIcon, CubeIcon } from '../icons.js';
import { useFloatingMenu } from './floatingMenu.js';
import { hardwareRows, LocalModels } from './MonitorsDock.js';
import { useMonitors, useResourceSample } from './ResourceMonitor.js';

/*
 * Simple and Expert, the phone's chat modes (decision 0024, spec
 * phone/iphone-simple-and-expert-modes), on the desktop chat. Simple keeps the
 * chat's model, effort and context; Expert adds a strip of the machine's
 * hardware as dials and the models the Model Server holds.
 */

const MODE_KEY = 'nekko.chatMode';
const modeListeners = new Set<() => void>();
const readExpert = () => {
  try { return window.localStorage.getItem(MODE_KEY) === 'expert'; } catch { return false; }
};

/** Expert mode, saved on this machine and shared by every open chat. */
export function useExpertMode(): [boolean, (on: boolean) => void] {
  const expert = useSyncExternalStore((fn) => { modeListeners.add(fn); return () => { modeListeners.delete(fn); }; }, readExpert, () => false);
  const set = (on: boolean) => {
    try { window.localStorage.setItem(MODE_KEY, on ? 'expert' : 'simple'); } catch { /* best effort */ }
    for (const l of modeListeners) l();
  };
  return [expert, set];
}

/** A popover in a portal that closes on an outside click or Escape. */
export function usePopover(width: number, tallest?: number) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const style = useFloatingMenu(open, anchor, width, tallest);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (!anchor.current?.contains(t) && !pop.current?.contains(t)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, anchor, pop, style };
}

/** Simple or Expert, at the top left of the chat. */
export function ModeToggle() {
  const [expert, setExpert] = useExpertMode();
  return (
    <button
      type="button"
      className={`btn btn-ghost shrink-0 gap-1 px-1.5 py-1 text-2xs font-medium ${expert ? 'text-accent' : ''}`}
      onClick={() => setExpert(!expert)}
      aria-pressed={expert}
      title={expert ? 'Expert: the hardware and loaded models are shown. Click for Simple.' : 'Simple. Click for Expert, which adds the hardware and loaded models.'}
      data-chat-mode={expert ? 'expert' : 'simple'}
    >
      <GaugeIcon className="h-3.5 w-3.5" />
      <span>{expert ? 'Expert' : 'Simple'}</span>
    </button>
  );
}

/* ── Gauges ─────────────────────────────────────────────────────────────── */

/** Where `fraction` of a 240° sweep, open at the bottom, lands on a circle. */
const at = (c: number, r: number, fraction: number) => {
  const a = ((150 + 240 * Math.max(0, Math.min(1, fraction))) * Math.PI) / 180;
  return { x: c + r * Math.cos(a), y: c + r * Math.sin(a) };
};

/** A gauge's arc, `fraction` of the sweep, as an SVG path. */
export function arcPath(size: number, width: number, fraction: number): string {
  const c = size / 2;
  const r = c - width / 2;
  const f = Math.max(0, Math.min(1, fraction));
  const s = at(c, r, 0);
  const e = at(c, r, f);
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${240 * f > 180 ? 1 : 0} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

/** Load colour, as on the phone's dials: warning above 70%, danger above 90%. */
const tone = (pct: number) => (pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--accent)');

/** How hard the model works, as a dial: one notch per level the model takes. */
export function EffortDial({ index, count, size = 18 }: { index: number; count: number; size?: number }) {
  const f = (index + 1) / Math.max(1, count);
  const w = Math.max(2, size * 0.12);
  const c = size / 2;
  const tip = at(c, c * 0.72, f);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="effort-dial shrink-0">
      <path d={arcPath(size, w, 1)} fill="none" stroke="var(--surface-2)" strokeWidth={w} strokeLinecap="round" />
      <path d={arcPath(size, w, f)} fill="none" stroke="var(--accent)" strokeWidth={w} strokeLinecap="round" />
      <line x1={c} y1={c} x2={tip.x} y2={tip.y} stroke="var(--ink)" strokeWidth={Math.max(1.5, size * 0.07)} strokeLinecap="round" style={{ transition: 'all 200ms ease-out' }} />
      <circle cx={c} cy={c} r={size * 0.08} fill="var(--ink)" />
    </svg>
  );
}

/** One reading as a dial: the arc fills with the load, the value in the middle. */
export function RingDial({ pct, value, label, temp, size = 40 }: { pct: number | null; value: string; label: string; temp?: number; size?: number }) {
  const w = size * 0.1;
  const t = formatTemperature(temp);
  const tTone = temp == null ? 'ok' : temperatureTone(temp);
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5" role="img" aria-label={`${label}: ${value}${t ? `, ${t}` : ''}`} data-dial={label}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <path d={arcPath(size, w, 1)} fill="none" stroke="var(--surface-2)" strokeWidth={w} strokeLinecap="round" />
          {pct != null && <path d={arcPath(size, w, pct / 100)} fill="none" stroke={tone(pct)} strokeWidth={w} strokeLinecap="round" />}
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center leading-none tabular-nums">
          <span className={`font-semibold ${pct == null ? 'text-ink-faint' : 'text-ink'}`} style={{ fontSize: Math.max(10, size * 0.24) }}>{value}</span>
          {t && <span style={{ fontSize: Math.max(8, size * 0.17), color: tTone === 'ok' ? 'var(--ink-soft)' : tTone === 'warn' ? 'var(--warning)' : 'var(--danger)' }}>{t}</span>}
        </span>
      </div>
      <span className="max-w-[64px] truncate text-2xs text-ink-soft">{label}</span>
    </div>
  );
}

/* ── Expert monitor ─────────────────────────────────────────────────────── */

/** The Hardware monitor's rows as dials: short labels, a percent in the middle. */
function useDials() {
  const monitors = useMonitors();
  const { system, gpu } = useResourceSample();
  const one = (gpu?.devices.length ?? 0) <= 1;
  return hardwareRows(monitors, system, gpu)
    .filter((r) => r.text !== 'Monitor off')
    // "GPU 2: RTX 4090" names a dial "GPU 2"; the only GPU is just "GPU", as on the phone.
    .map((r) => ({ label: one && r.label.startsWith('GPU ') && r.label.includes(':') ? 'GPU' : r.label.split(':')[0], pct: r.value == null ? null : Math.max(0, Math.min(100, r.value)), value: r.value == null ? '–' : `${Math.round(r.value)}%`, temp: r.temp }));
}

/** How often the loaded count re-reads the engine, as the Local models monitor does. */
const ENGINE_POLL_MS = 6000;

function useLoadedCount(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => window.nekko.engineStatus().then((s) => { if (live) setN(s?.running ? s.resident.length : 0); }).catch(() => {});
    read();
    const t = setInterval(read, ENGINE_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  return n;
}

/**
 * Expert mode's strip under the chat's header: the hardware as small dials and
 * how many models the Model Server holds. Click for larger dials and the models.
 */
export function ExpertMonitor() {
  const dials = useDials();
  const loaded = useLoadedCount();
  const { open, setOpen, anchor, pop, style } = usePopover(360, 560);
  return (
    <div className="shrink-0 border-b border-line px-3 py-1.5" data-expert-monitor>
      <button
        ref={anchor}
        type="button"
        className="flex w-full items-start gap-3 overflow-x-auto rounded-lg px-1 py-0.5 text-left hover:bg-(--surface-2)"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Monitor: ${dials.map((d) => `${d.label} ${d.value}`).join(', ')}, ${loaded ?? 0} models loaded`}
      >
        {dials.length === 0
          ? <span className="flex h-10 items-center text-2xs text-ink-faint">Hardware monitors are off in Settings.</span>
          : dials.map((d) => <RingDial key={d.label} {...d} size={40} />)}
        <span className="ml-auto flex shrink-0 flex-col items-center gap-0.5 pl-2">
          <CubeIcon className="h-4 w-4 text-accent" />
          <span className="text-2xs font-semibold tabular-nums text-ink">{loaded ?? '–'}</span>
          <span className="text-2xs text-ink-soft">Loaded</span>
        </span>
      </button>
      {open && createPortal(
        <div ref={pop} style={style} className="card fixed z-[100] overflow-y-auto p-3 shadow-(--shadow-float)" role="dialog" aria-label="Monitor" data-expert-monitor-sheet>
          <div className="mb-2 text-xs font-semibold text-ink">Hardware</div>
          <div className="mb-3 grid grid-cols-4 gap-3">{dials.map((d) => <RingDial key={d.label} {...d} size={60} />)}</div>
          <div className="mb-1 text-xs font-semibold text-ink">Loaded models</div>
          <LocalModels />
        </div>,
        document.body,
      )}
    </div>
  );
}
