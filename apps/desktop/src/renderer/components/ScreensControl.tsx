import React, { useEffect, useId, useRef, useState } from 'react';
import { displaysBridge, prefersReducedMotion, useDisplays, type DesktopInfo, type DisplayInfo, type DisplayPlacement, type DisplaysState, type SpacesMode } from '../displays.js';
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

export const SPACES_OPTIONS: Array<{ key: Exclude<SpacesMode, 'ask'>; label: string; hint: string }> = [
  { key: 'switch', label: 'Switch me there', hint: 'Turning on a desktop jumps to it and opens Nekko there. Needs Accessibility.' },
  { key: 'arrive', label: 'Open when I get there', hint: 'The window waits and opens the next time you switch to that desktop.' },
];

/**
 * An abstract monitor: its desktops slide over to the next one, then a new
 * window swipes open on it. Loops; reduced motion shows the last frame.
 */
export function SpacesSwitchDemo() {
  const clip = `spaces-demo-${useId().replace(/:/g, '')}`;
  return <svg className="spaces-demo" viewBox="0 0 160 104" role="img" aria-label="The screen slides to the next desktop and a Nekko window opens there">
    <defs><clipPath id={clip}><rect x="14" y="10" width="132" height="72" rx="3" /></clipPath></defs>
    <rect className="spaces-demo__bezel" x="10" y="6" width="140" height="80" rx="6" />
    <path className="spaces-demo__bezel" d="M72 86h16l4 9H68z" />
    <g clipPath={`url(#${clip})`}>
      <g className="spaces-demo__strip">
        <rect className="spaces-demo__desk" x="14" y="10" width="132" height="72" />
        <rect className="spaces-demo__win" x="24" y="20" width="52" height="34" rx="3" />
        <rect className="spaces-demo__win" x="84" y="34" width="50" height="38" rx="3" />
        <rect className="spaces-demo__desk spaces-demo__desk--next" x="150" y="10" width="132" height="72" />
        <g className="spaces-demo__nekko">
          <rect x="156" y="16" width="120" height="60" rx="3" />
          <rect className="spaces-demo__nekko-bar" x="156" y="16" width="120" height="8" rx="3" />
          <rect className="spaces-demo__nekko-pane" x="162" y="30" width="52" height="40" rx="2" />
          <rect className="spaces-demo__nekko-pane" x="218" y="30" width="52" height="40" rx="2" />
        </g>
      </g>
    </g>
    <circle className="spaces-demo__dot spaces-demo__dot--one" cx="74" cy="100" r="2" />
    <circle className="spaces-demo__dot spaces-demo__dot--two" cx="86" cy="100" r="2" />
  </svg>;
}

/** A desktop in the Desktops row, drawn at the main screen's shape. */
function DesktopTile({ desktop, w, h, busy, onToggle }: { desktop: DesktopInfo; w: number; h: number; busy: boolean; onToggle: () => void }) {
  const state = desktop.main ? 'main window, always on' : desktop.waiting ? 'opens when you get there' : desktop.enabled ? 'on' : 'off';
  const tag = desktop.main ? 'Main' : desktop.self ? 'Here' : desktop.waiting ? 'Waiting' : null;
  return <button type="button" className="screens-tile" role="switch" aria-checked={desktop.enabled} aria-label={`Desktop ${desktop.label}, ${state}${desktop.current ? ', current' : ''}`}
    aria-disabled={desktop.main || busy} data-main={desktop.main ? '' : undefined} data-current={desktop.current ? '' : undefined} data-waiting={desktop.waiting ? '' : undefined}
    title={desktop.main ? 'The main window\u2019s desktop stays on' : desktop.enabled ? 'Close this desktop\u2019s Nekko window' : 'Open a Nekko window on this desktop'}
    style={{ width: w, height: h }} onClick={() => { if (!desktop.main && !busy) onToggle(); }}>
    <span className="screens-tile__num">{desktop.label}</span>
    {tag && <span className="screens-tile__tag">{tag}</span>}
  </button>;
}

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
    }}
    onToggleDesktop={async (d, mode) => {
      setBusy(true);
      try {
        if (mode) setState(await displaysBridge!.setSpacesMode(mode));
        setState(await displaysBridge!.toggleDesktop(d.id, !d.enabled));
      } catch (e) { useStore.getState().pushToast('error', `Could not change desktops: ${(e as Error).message}`); }
      finally { setBusy(false); }
    }}
    onSpacesMode={async (m) => {
      try { setState(await displaysBridge!.setSpacesMode(m)); }
      catch (e) { useStore.getState().pushToast('error', `Could not save the desktop option: ${(e as Error).message}`); }
    }} />;
}

/** The control's markup, separate so it renders without the desktop bridge (tests, fixtures). */
export function ScreensMenu({ state, open, busy = false, rootRef, onHover, onToggleOpen, onToggle, onPlacement, onToggleDesktop, onSpacesMode, asking: initialAsking = null }: {
  state: DisplaysState;
  open: boolean;
  busy?: boolean;
  rootRef?: React.Ref<HTMLDivElement>;
  onHover?: (over: boolean) => void;
  onToggleOpen?: () => void;
  onToggle: (display: DisplayInfo) => void;
  onPlacement: (placement: DisplayPlacement) => void;
  /** `mode`: chosen in the permission explainer just now, saved before the toggle. */
  onToggleDesktop?: (desktop: DesktopInfo, mode?: Exclude<SpacesMode, 'ask'>) => void;
  onSpacesMode?: (mode: Exclude<SpacesMode, 'ask'>) => void;
  /** The desktop whose explainer is open (fixtures and tests start with one). */
  asking?: string | null;
}) {
  const [asking, setAsking] = useState<string | null>(initialAsking);
  const spaces = state.spaces;
  const mainDisplay = state.displays.find((d) => d.main) ?? state.displays[0];
  const deskW = 64, deskH = Math.max(36, Math.round(deskW * (mainDisplay ? mainDisplay.bounds.height / mainDisplay.bounds.width : 0.625)));
  const askingDesktop = spaces?.desktops.find((d) => d.id === asking);
  const toggleDesktop = (d: DesktopInfo) => {
    // The first time, explain the permission before anything happens.
    if (!d.enabled && spaces?.mode === 'ask') { setAsking(d.id); return; }
    onToggleDesktop?.(d);
  };
  const on = state.displays.filter((d) => d.enabled).length;
  // Fit the row: the widest screen is drawn 96px wide, the rest to scale.
  const scale = 96 / Math.max(1, ...state.displays.map((d) => d.bounds.width));
  return <div className="screens-control" ref={rootRef} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)}>
    <button type="button" className="btn btn-outline gap-1.5 py-1 text-[12px]" aria-haspopup="dialog" aria-expanded={open}
      aria-label={state.displays.length < 2 && state.spaces ? `Desktops: ${state.spaces.desktops.filter((d) => d.enabled).length} of ${state.spaces.desktops.length} on` : `Screens: ${on} of ${state.displays.length} on`} title="Screens" data-screens-button onClick={onToggleOpen}>
      <MultiMonitorIcon className="h-4 w-4" />{state.displays.length > 1
        ? <span className="tabular-nums">{on}/{state.displays.length}</span>
        : state.spaces && <span className="tabular-nums">{state.spaces.desktops.filter((d) => d.enabled).length}/{state.spaces.desktops.length}</span>}
    </button>
    {open && <div className="screens-picker" role="dialog" aria-label="Screens">
      {/* One screen with desktops: a lone Main tile says nothing, so only the desktops show. */}
      {(state.displays.length > 1 || !spaces) && <>
        <p className="screens-picker__title">Screens</p>
        <div className="screens-row" role="group" aria-label="Screens to use">
          {state.displays.map((d) => <ScreenTile key={d.id} display={d} scale={scale} busy={busy} onToggle={() => onToggle(d)} />)}
        </div>
      </>}
      {state.displays.length < 2 && !spaces && <p className="screens-picker__note">Connect another screen to spread agents across it.</p>}
      {spaces && <>
        <p className={`screens-picker__title ${state.displays.length > 1 ? 'screens-picker__title--sub' : ''}`}>Desktops</p>
        <div className="screens-row" role="group" aria-label="Desktops to use">
          {spaces.desktops.map((d) => <DesktopTile key={d.id} desktop={d} w={deskW} h={deskH} busy={busy} onToggle={() => toggleDesktop(d)} />)}
        </div>
        {askingDesktop && <div className="spaces-ask" role="group" aria-label={`Open Nekko on Desktop ${askingDesktop.label}`}>
          <SpacesSwitchDemo />
          <p className="spaces-ask__lead">Jump to Desktop {askingDesktop.label} and open Nekko there?</p>
          <p className="spaces-ask__body">macOS only lets an app change desktops by pressing its shortcuts for you, which needs the <strong>Accessibility</strong> permission (macOS also asks once to let Nekko control System Events). It also lets you say &ldquo;Nekko, switch to desktop 2&rdquo;. Without it, the window opens the next time you go to that desktop yourself.</p>
          <div className="spaces-ask__actions">
            <button type="button" className="btn btn-primary py-1 text-[12px]" onClick={() => { setAsking(null); onToggleDesktop?.(askingDesktop, 'switch'); }}>Allow and switch</button>
            <button type="button" className="btn btn-outline py-1 text-[12px]" onClick={() => { setAsking(null); onToggleDesktop?.(askingDesktop, 'arrive'); }}>Open when I get there</button>
          </div>
        </div>}
        {spaces.mode === 'switch' && !spaces.access && <p className="screens-picker__note">Accessibility is off for Nekko in System Settings, so desktop windows open when you get there.</p>}
      </>}
      <hr className="screens-picker__divider" />
      <p className="screens-picker__title">View options</p>
      <div role="radiogroup" aria-label="Where new agent windows open" className="screens-options">
        {PLACEMENT_OPTIONS.map((o) => <label key={o.key} className="screens-option">
          <input type="radio" name="screens-placement" checked={state.placement === o.key} onChange={() => onPlacement(o.key)} />
          <span><strong>{o.label}</strong><span>{o.hint}</span></span>
        </label>)}
      </div>
      {spaces && spaces.mode !== 'ask' && <div role="radiogroup" aria-label="How a desktop is reached" className="screens-options mt-2">
        {SPACES_OPTIONS.map((o) => <label key={o.key} className="screens-option">
          <input type="radio" name="screens-spaces-mode" checked={spaces.mode === o.key} onChange={() => onSpacesMode?.(o.key)} />
          <span><strong>{o.label}</strong><span>{o.hint}</span></span>
        </label>)}
      </div>}
    </div>}
  </div>;
}
