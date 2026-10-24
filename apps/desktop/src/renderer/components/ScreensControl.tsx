import React, { useEffect, useRef, useState } from 'react';
import { displaysBridge, prefersReducedMotion, useDisplays, type DisplayInfo, type DisplayPlacement, type DisplaysState } from '../displays.js';
import { useStore } from '../store.js';

/** Two screens side by side: the toolbar button's glyph. */
export function MultiMonitorIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="5" width="11" height="8" rx="1.5" /><path d="M7.5 13v3M5 16h5" />
    <rect x="11" y="9" width="11" height="8" rx="1.5" fill="var(--paper, transparent)" /><path d="M16.5 17v3M14 20h5" />
  </svg>;
}

export const PLACEMENT_OPTIONS: Array<{ key: DisplayPlacement; label: string; hint: string }> = [
  { key: 'empty-first', label: 'Prioritize empty windows', hint: 'New agent windows open on an empty screen first, then wherever has the fewest.' },
  { key: 'main-first', label: 'Prioritize the main window', hint: 'New agent windows open on the main screen; the others keep what you open there.' },
];

/**
 * A screen in the row, drawn in proportion to its real shape. The main screen
 * is always on (locked); the others toggle a window of their own on and off.
 */
function ScreenTile({ display, scale, busy, onToggle }: { display: DisplayInfo; scale: number; busy: boolean; onToggle: () => void }) {
  const w = Math.max(44, Math.round(display.bounds.width * scale));
  const h = Math.max(28, Math.round(display.bounds.height * scale));
  const label = `Screen ${display.label}${display.main ? ', main window, always on' : display.enabled ? ', on' : ', off'}`;
  return <button type="button" className="screens-tile" role="switch" aria-checked={display.enabled} aria-label={label}
    aria-disabled={display.main || busy} data-main={display.main ? '' : undefined} data-self={display.self ? '' : undefined}
    title={display.main ? 'The main window\u2019s screen stays on' : display.enabled ? 'Turn this screen off' : 'Open a Nekko window on this screen'}
    style={{ width: w, height: h }} onClick={() => { if (!display.main && !busy) onToggle(); }}>
    <span className="screens-tile__num">{display.label}</span>
    {display.main && <span className="screens-tile__tag">Main</span>}
    {display.self && !display.main && <span className="screens-tile__tag">Here</span>}
  </button>;
}

/**
 * The Dynamic toolbar's Screens button: hover (or click, or focus) opens a
 * dropdown like the grid-size picker, with every connected screen in a row.
 * Turning a screen on opens a full Nekko window there that swipes in from the
 * left; turning it off shrinks it into the right edge. Below a divider, the
 * view options choose where new agent windows open.
 */
export function ScreensControl() {
  const [state, setState] = useDisplays();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  // Only the desktop shell has screens to spread over.
  if (!displaysBridge || !state) return null;
  return <ScreensMenu state={state} open={open} busy={busy} rootRef={ref}
    onHover={(over) => { clearTimeout(closeTimer.current); if (over) setOpen(true); else closeTimer.current = setTimeout(() => setOpen(false), 180); }}
    // Hover has usually opened it already, so a click must not toggle it shut;
    // Escape or a click outside closes it.
    onToggleOpen={() => { clearTimeout(closeTimer.current); setOpen(true); }}
    onToggle={async (d) => {
      setBusy(true);
      try { setState(await displaysBridge!.toggle(d.id, !d.enabled, prefersReducedMotion())); }
      catch (e) { useStore.getState().pushToast('error', `Could not change screens: ${(e as Error).message}`); }
      finally { setBusy(false); }
    }}
    onPlacement={async (p) => {
      try { setState(await displaysBridge!.setPlacement(p)); }
      catch (e) { useStore.getState().pushToast('error', `Could not save the view option: ${(e as Error).message}`); }
    }} />;
}

/** The control's markup, separate so it renders without the desktop bridge (tests, fixtures). */
export function ScreensMenu({ state, open, busy = false, rootRef, onHover, onToggleOpen, onToggle, onPlacement }: {
  state: DisplaysState;
  open: boolean;
  busy?: boolean;
  rootRef?: React.Ref<HTMLDivElement>;
  onHover?: (over: boolean) => void;
  onToggleOpen?: () => void;
  onToggle: (display: DisplayInfo) => void;
  onPlacement: (placement: DisplayPlacement) => void;
}) {
  const on = state.displays.filter((d) => d.enabled).length;
  // Fit the row: the widest screen is drawn 96px wide, the rest to scale.
  const scale = 96 / Math.max(1, ...state.displays.map((d) => d.bounds.width));
  return <div className="screens-control" ref={rootRef} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)}>
    <button type="button" className="btn btn-outline gap-1.5 py-1 text-[12px]" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Screens: ${on} of ${state.displays.length} on`} title="Screens" data-screens-button onClick={onToggleOpen}>
      <MultiMonitorIcon className="h-4 w-4" />{state.displays.length > 1 && <span className="tabular-nums">{on}/{state.displays.length}</span>}
    </button>
    {open && <div className="screens-picker" role="dialog" aria-label="Screens">
      <p className="screens-picker__title">Screens</p>
      <div className="screens-row" role="group" aria-label="Screens to use">
        {state.displays.map((d) => <ScreenTile key={d.id} display={d} scale={scale} busy={busy} onToggle={() => onToggle(d)} />)}
      </div>
      {state.displays.length < 2 && <p className="screens-picker__note">Connect another screen to spread agents across it.</p>}
      <hr className="screens-picker__divider" />
      <p className="screens-picker__title">View options</p>
      <div role="radiogroup" aria-label="Where new agent windows open" className="screens-options">
        {PLACEMENT_OPTIONS.map((o) => <label key={o.key} className="screens-option">
          <input type="radio" name="screens-placement" checked={state.placement === o.key} onChange={() => onPlacement(o.key)} />
          <span><strong>{o.label}</strong><span>{o.hint}</span></span>
        </label>)}
      </div>
    </div>}
  </div>;
}
