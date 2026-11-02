import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AutomationTask, EngineStatus, GpuStats, LocalModel, MonitorKind, ProviderConfig, RuntimeStatus, SessionSummary, SystemStats, UsageSummary } from '@nekko-agent/shared';
import { formatTemperature, temperatureTone, RUNTIME_CAPABILITIES, MODEL_PRICING, MODEL_COMPARISON_TIERS, MODEL_PRICING_SOURCE, MODEL_PRICING_CHECKED_AT, getModelPrice, DEFAULT_LOCAL_COST_BENCHMARK, describeLimitsProblem, formatUSD, gpuMemoryLabel, isLocalProvider, limitsKeyFor, oauthProviderOffered } from '@nekko-agent/shared';
import { MONITORS, normalizeMonitorOrder, placeMonitor, reorderMonitor, type CommandWallState, type InsightsPrefs, type MonitorKey } from '../commandWall.js';
import { useStore } from '../store.js';
import { useProviderLimitsPortfolio } from '../useLimits.js';
import { accountEmailOf, useAccountEmails } from '../accountEmails.js';
import { BUDGET_RANGE_LABEL, budgetRange, localRuntimeMetrics, utilizationProviders } from './monitorMetrics.js';
import { AutomationsPane } from './AutomationsPane.js';
import { InsightsBox, type Vitals } from './InsightsBox.js';
import { RangeToggles } from './RangeToggles.js';
import type { InsightRange } from '../insightRanges.js';
import { MonitorComputerSwitch, useMonitors, useResourceSample } from './ResourceMonitor.js';
import { BackgroundChip, useBackgroundState } from './BackgroundChip.js';
import { BrainIcon, ServerIcon, MoneyIcon, ListIcon, GearIcon, SlidersIcon, CloseIcon, MinimizeIcon, CubeIcon, PanelIcon } from '../icons.js';
import { formatBytes, formatTokens, placementLabel, placementTitle } from './runtimes/verdict.js';
import { HoverTip } from './HoverTip.js';
import './monitorsDock.css';
import type { OAuthStatus } from '@nekko-agent/shared';
import { SubscriptionSignIn } from './SubscriptionSignIn.js';
import { SUBSCRIPTION_KINDS, reconnectProviderConfig } from './providers/AddProvider.js';
import { usePanelPresence } from '../usePanelPresence.js';
import { dockMinimizeTransition } from './dockMinimize.js';
import { EASE_OUT } from '../easing.js';

const MONITOR_ICONS = { automations: GearIcon, utilization: ListIcon, budget: MoneyIcon, insights: BrainIcon, hardware: ServerIcon, localModels: CubeIcon };

export interface MonitorsDockProps {
  state: CommandWallState;
  setState: (update: (state: CommandWallState) => CommandWallState) => void;
  tasks: AutomationTask[];
  running: Set<string>;
  now: number;
  sessions: SessionSummary[];
  providers: ProviderConfig[];
  usage: UsageSummary | null;
  vitals: Vitals;
  onOpenChat: (id: string) => void;
  onOpenModels: () => void;
}

const DEFAULT_DOCK_WIDTH = 276;

/**
 * The dock's show/hide button: an icon (the agent panel's pill, mirrored), with
 * what it does in a hover tooltip. It sits at the top right of the dock's
 * header, and stays in the dock's place when the dock is hidden.
 */
export function MonitorsToggle({ show, side, onToggle }: { show: boolean; side: CommandWallState['dock']['side']; onToggle: () => void }) {
  const tipSide = side === 'left' ? 'right' : side === 'right' && !show ? 'left' : 'bottom';
  return (
    <HoverTip label={show ? 'Hide monitors' : 'Show monitors'} side={tipSide}>
      <button type="button" className="agent-panel-pill monitors-dock__toggle" aria-label={show ? 'Hide the monitors panel' : 'Show the monitors panel'} aria-pressed={show} onClick={onToggle}>
        <PanelIcon className="h-4 w-4 shrink-0" />
      </button>
    </HoverTip>
  );
}

/** A flow-layout sibling of the wall stage. The parent places it using data-dock-side. */
export function MonitorsDock(props: MonitorsDockProps) {
  const { state, setState } = props;
  const { dock } = state;
  const background = useBackgroundState();
  const present = usePanelPresence(dock.show);
  const reorderDrag = useRef<MonitorKey | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const sideDock = dock.side === 'left' || dock.side === 'right';
  const reorder = (key: MonitorKey, target: MonitorKey) => {
    setState((s) => ({ ...s, dock: { ...s.dock, monitorOrder: reorderMonitor(s.dock.monitorOrder, key, target) } }));
    setReorderAnnouncement(`${MONITORS.find(p => p.key === key)!.label} moved ${normalizeMonitorOrder(dock.monitorOrder).indexOf(key) < normalizeMonitorOrder(dock.monitorOrder).indexOf(target) ? 'down' : 'up'}.`);
  };
  // Drag to reorder: the lifted monitor leaves the column and a dashed landing
  // zone of its height opens where it would land. Zones sit before each other
  // monitor (and at the end) and grow or shrink with a transition, so neighbours
  // slide apart rather than jump. On drop the monitor flies from the pointer
  // into the zone it fills.
  const [lift, setLift] = useState<{ key: MonitorKey; height: number } | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  // The first zone opens without a transition, in the lifted monitor's own place.
  const [lifting, setLifting] = useState(false);
  useEffect(() => {
    if (!lifting) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setLifting(false)));
    return () => cancelAnimationFrame(frame);
  }, [lifting]);
  const grab = useRef({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 });
  const liftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const monitorsRef = useRef<HTMLDivElement>(null);
  const landed = useRef<{ key: MonitorKey; x: number; y: number } | null>(null);
  useEffect(() => () => clearTimeout(liftTimer.current), []);
  /** Where the pointer sits among the monitors still in the column: before the first monitor whose middle is below it. */
  const slotAt = (y: number) => {
    const rest = [...(monitorsRef.current?.querySelectorAll<HTMLElement>('[data-monitor]:not([data-monitor-lifted])') ?? [])];
    const i = rest.findIndex((node) => { const r = node.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i < 0 ? rest.length : i;
  };
  const endDrag = (flyFrom: { x: number; y: number } | null) => {
    clearTimeout(liftTimer.current);
    if (flyFrom && lift) landed.current = { key: lift.key, ...flyFrom };
    reorderDrag.current = null;
    setLift(null);
    setSlot(null);
  };
  // After a drop (or a cancelled drag) the monitor is back in the column: start
  // it where the dragged ghost was and let it settle into its new place.
  useLayoutEffect(() => {
    const flight = landed.current;
    if (!flight || lift) return;
    landed.current = null;
    const node = monitorsRef.current?.querySelector<HTMLElement>(`[data-monitor="${flight.key}"]`);
    if (!node || typeof node.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = node.getBoundingClientRect();
    const dx = flight.x - grab.current.x - r.left;
    const dy = flight.y - grab.current.y - r.top;
    if (Math.hypot(dx, dy) < 2) return;
    node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(1.02)`, boxShadow: '0 14px 30px -14px rgb(0 0 0 / .5)' },
      { transform: 'none', boxShadow: '0 0 0 0 rgb(0 0 0 / 0)' },
    ], { duration: 280, easing: EASE_OUT });
  }, [lift]);
  const [width, setWidth] = useState(DEFAULT_DOCK_WIDTH);
  // A width drag measures its room once and writes --dock-width straight onto
  // the dock; state takes the final width on release.
  const drag = useRef<{ x: number; width: number; room: number; last?: number } | null>(null);
  const size = (value: number) => { const next = Math.max(260, Math.min(600, value)); setWidth(Math.abs(next - DEFAULT_DOCK_WIDTH) <= 20 ? DEFAULT_DOCK_WIDTH : next); };
  const [collapsing, setCollapsing] = useState<MonitorKey | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const focusMonitor = useRef<{ key: MonitorKey; minimized: boolean } | null>(null);
  const minimizeTransition = useRef(dockMinimizeTransition());
  useEffect(() => () => minimizeTransition.current.cancel(), []);
  useEffect(() => {
    const pending = focusMonitor.current;
    if (!pending || Boolean(dock.minimized[pending.key]) !== pending.minimized) return;
    const label = MONITORS.find(p => p.key === pending.key)!.label;
    dockRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="${pending.minimized ? 'Expand' : 'Minimize'} ${label} monitor"]`)?.focus();
    focusMonitor.current = null;
  }, [dock.minimized]);
  const [configure, setConfigure] = useState(false);
  const configureRef = useRef<HTMLDivElement>(null);
  const configureButton = useRef<HTMLButtonElement>(null);
  const configurePopover = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!configure) return;
    const menu = configurePopover.current;
    if (!menu) return;
    menu.showPopover();
    const position = () => {
      const anchor = configureButton.current?.getBoundingClientRect();
      if (!anchor) return;
      const bounds = menu.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12));
      const preferred = dock.side === 'bottom' ? anchor.top - bounds.height - 6 : anchor.bottom + 6;
      menu.style.left = `${left}px`;
      menu.style.top = `${Math.max(12, Math.min(preferred, window.innerHeight - bounds.height - 12))}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      if (menu.matches(':popover-open')) menu.hidePopover();
    };
  }, [configure, dock.side]);
  useEffect(() => {
    if (!configure) return;
    const down = (e: MouseEvent) => { if (!configureRef.current?.contains(e.target as Node)) setConfigure(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfigure(false); configureButton.current?.focus(); }
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [configure]);
  const patch = (next: Partial<CommandWallState['dock']>) => setState((s) => ({ ...s, dock: { ...s.dock, ...next } }));
  const toggleMonitor = (key: MonitorKey, enabled: boolean) => setState((s) => ({ ...s, dock: { ...s.dock, monitors: { ...s.dock.monitors, [key]: enabled } } }));
  const insights = (prefs: InsightsPrefs) => setState((s) => ({ ...s, insights: prefs }));
  const insightProps = { usage: props.usage, sessions: props.sessions, providers: props.providers, vitals: props.vitals, onOpenModels: props.onOpenModels };

  const minimize = (key: MonitorKey, value: boolean) => {
    minimizeTransition.current.cancel();
    const commit = () => {
      focusMonitor.current = { key, minimized: value };
      setState((s) => ({ ...s, dock: { ...s.dock, minimized: { ...s.dock.minimized, [key]: value } } }));
      setCollapsing(null);
    };
    minimizeTransition.current.start(!value || window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => setCollapsing(key), commit);
  };

  const setShow = (show: boolean) => setState((s) => ({ ...s, dock: { ...s.dock, show } }));
  // Hidden, the dock leaves only its own show button where it was, the way the
  // agent panel leaves its controls, so the way back is where it went.
  const collapsed = !dock.show && (
    <div className="monitors-dock-collapsed" data-dock-side={dock.side}>
      <MonitorsToggle show={false} side={dock.side} onToggle={() => setShow(true)} />
    </div>
  );
  if (!present) return collapsed;
  const selectedMonitors = normalizeMonitorOrder(dock.monitorOrder).map(key => MONITORS.find(p => p.key === key)!).filter((p) => dock.monitors[p.key]);
  const expandedMonitors = selectedMonitors.filter((p) => !dock.minimized[p.key]);
  return (
    <>
    {collapsed}
    <aside data-panel-open={dock.show} inert={!dock.show} aria-hidden={!dock.show} ref={dockRef} className="monitors-dock" style={{ '--dock-width': `${width}px` } as React.CSSProperties} data-dock-side={dock.side} aria-label="Monitors">
      {(dock.side === 'left' || dock.side === 'right') && <div className="monitors-dock__resize" role="separator" tabIndex={0} aria-label="Resize monitors" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={600} aria-valuenow={width} title="Drag to resize monitors; double-click to reset"
        onPointerDown={(e) => { drag.current = { x: e.clientX, width, room: (e.currentTarget.parentElement?.parentElement?.clientWidth ?? 1000) - 240 }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const next = Math.max(260, Math.min(600, Math.min(d.room, d.width + (e.clientX - d.x) * (dock.side === 'left' ? 1 : -1))));
          d.last = Math.abs(next - DEFAULT_DOCK_WIDTH) <= 20 ? DEFAULT_DOCK_WIDTH : next;
          dockRef.current?.style.setProperty('--dock-width', `${d.last}px`);
        }}
        onPointerUp={() => { const last = drag.current?.last; drag.current = null; if (last != null) setWidth(last); }} onPointerCancel={() => { drag.current = null; }} onDoubleClick={() => setWidth(DEFAULT_DOCK_WIDTH)}
        onKeyDown={(e) => { if (e.key === 'Home') { e.preventDefault(); setWidth(DEFAULT_DOCK_WIDTH); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); size(width + (e.key === 'ArrowRight' ? 24 : -24) * (dock.side === 'left' ? 1 : -1)); } }}>
        {/* The agent list's grip: a thin line that shows on hover and focus. */}
        <span aria-hidden className="pane-grip monitors-dock__grip" />
      </div>}
      <header className="monitors-dock__toolbar">
        <strong>Monitors</strong>
        <span className="monitors-dock__count">{selectedMonitors.length} of {MONITORS.length}</span>
        <MonitorComputerSwitch />
        <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{reorderAnnouncement}</span>
        <div className="monitors-dock__configure" ref={configureRef}>
          <button type="button" ref={configureButton} aria-expanded={configure} onClick={() => setConfigure((v) => !v)} title="Configure monitors" aria-label="Configure monitors"><SlidersIcon className="monitors-dock__icon" /> Configure</button>
          {configure && <div ref={configurePopover} popover="manual" className="monitors-dock__popover" role="group" aria-label="Monitors configuration">
            <fieldset><legend>Position</legend><div className="monitors-dock__positions">
              {(['left', 'right', 'top', 'bottom'] as const).map((side) => <button type="button" key={side} aria-pressed={dock.side === side} onClick={() => patch({ side })}>{side[0].toUpperCase() + side.slice(1)}</button>)}
            </div></fieldset>
            <fieldset><legend>Panels</legend>{MONITORS.map((p) => <label key={p.key}><input type="checkbox" checked={dock.monitors[p.key]} onChange={(e) => toggleMonitor(p.key, e.target.checked)} /><span className="monitors-dock__option"><strong>{p.label}</strong><span>{p.blurb}</span></span></label>)}</fieldset>
          </div>}
        </div>
        <MonitorsToggle show side={dock.side} onToggle={() => setShow(false)} />
      </header>
      {/* Automations on a local model, and whether they are paused for you. */}
      {background.running > 0 && <div className="monitors-dock__background"><BackgroundChip state={background} /></div>}
      {selectedMonitors.some((p) => dock.minimized[p.key]) && <div className="monitors-dock__minimized" role="group" aria-label="Minimized monitors">
        {selectedMonitors.filter((p) => dock.minimized[p.key]).map((p) => { const Icon = MONITOR_ICONS[p.key]; return <button key={p.key} type="button" title={`Restore ${p.label}`} aria-label={`Expand ${p.label} monitor`} aria-expanded={false} onClick={() => minimize(p.key, false)}><Icon className="monitors-dock__icon" /></button>; })}
      </div>}
      <div ref={monitorsRef} className="monitors-dock__monitors" data-dock-dragging={lift ? '' : undefined} data-dock-lifting={lifting ? '' : undefined}
        onDragOver={(e) => {
          if (!sideDock || !reorderDrag.current) return;
          e.preventDefault(); e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          pointer.current = { x: e.clientX, y: e.clientY };
          if (lift) { const next = slotAt(e.clientY); if (next !== slot) setSlot(next); }
        }}
        onDrop={(e) => {
          if (!sideDock || !reorderDrag.current) return;
          e.preventDefault(); e.stopPropagation();
          const key = reorderDrag.current;
          const rest = expandedMonitors.filter((p) => p.key !== key);
          const at = Math.min(slot ?? slotAt(e.clientY), rest.length);
          const anchor = rest[at] ?? rest[rest.length - 1];
          if (anchor) {
            const where = rest[at] ? 'before' : 'after';
            setState((s) => ({ ...s, dock: { ...s.dock, monitorOrder: placeMonitor(s.dock.monitorOrder, key, anchor.key, where) } }));
            const before = expandedMonitors.findIndex((p) => p.key === key);
            if (at !== before) setReorderAnnouncement(`${MONITORS.find((p) => p.key === key)!.label} moved ${at > before ? 'down' : 'up'}.`);
          }
          endDrag({ x: e.clientX, y: e.clientY });
        }}>
        {expandedMonitors.map((p) => {
          const lifted = lift?.key === p.key;
          const restIndex = expandedMonitors.filter((q) => q.key !== lift?.key).findIndex((q) => q.key === p.key);
          return <React.Fragment key={p.key}>
          {lift && !lifted && <LandingZone open={slot === restIndex} height={lift.height} />}
          <section className={`monitors-dock__monitor${collapsing === p.key ? ' monitors-dock__monitor--collapsing' : ''}`} data-monitor={p.key} data-monitor-lifted={lifted ? '' : undefined} aria-label={`${p.label} monitor`}>
          <header className="monitors-dock__monitor-header" draggable={sideDock && collapsing === null} tabIndex={sideDock ? 0 : undefined}
            aria-label={sideDock ? `${p.label} monitor header; use Alt+ArrowUp or Alt+ArrowDown to reorder` : undefined}
            title={sideDock ? 'Drag header to reorder; Alt+ArrowUp/Down moves this monitor' : undefined}
            onDragStart={(e) => {
              if (!sideDock || collapsing !== null || (e.target as HTMLElement).closest('button')) { e.preventDefault(); return; }
              reorderDrag.current = p.key;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-nekko-monitor', p.key);
              e.stopPropagation();
              // The whole monitor follows the pointer, not just its header.
              const section = e.currentTarget.parentElement!;
              const r = section.getBoundingClientRect();
              grab.current = { x: e.clientX - r.left, y: e.clientY - r.top };
              pointer.current = { x: e.clientX, y: e.clientY };
              e.dataTransfer.setDragImage?.(section, grab.current.x, grab.current.y);
              // Lift on the next task: hiding the source inside dragstart
              // cancels the drag in Chromium. The zone opens where the monitor
              // was, at its height, so nothing below it moves yet.
              const height = r.height;
              const from = expandedMonitors.findIndex((q) => q.key === p.key);
              clearTimeout(liftTimer.current);
              liftTimer.current = setTimeout(() => { if (reorderDrag.current === p.key) { setLifting(true); setSlot(from); setLift({ key: p.key, height }); } });
            }}
            onDragEnd={(e) => {
              if (reorderDrag.current !== p.key) return;
              // Cancelled (dropped outside the column): fly back home.
              endDrag(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : pointer.current);
            }}
            onKeyDown={(e) => {
              if (!sideDock || collapsing !== null || e.target !== e.currentTarget || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
              e.preventDefault(); e.stopPropagation();
              const target = expandedMonitors[expandedMonitors.findIndex(m => m.key === p.key) + (e.key === 'ArrowDown' ? 1 : -1)];
              if (target) reorder(p.key, target.key);
            }}><span aria-hidden="true" title="Drag to reorder" className="text-ink-faint">⠿</span><span className="monitors-dock__monitor-icon">{React.createElement(MONITOR_ICONS[p.key], { className: 'monitors-dock__icon' })}</span><h2>{p.label}</h2><button type="button" title={`Minimize ${p.label}`} aria-label={`Minimize ${p.label} monitor`} aria-expanded={true} disabled={collapsing !== null} onClick={() => minimize(p.key, true)}><MinimizeIcon className="monitors-dock__icon" /></button><button type="button" title={`Remove ${p.label}`} aria-label={`Remove ${p.label} monitor`} onClick={() => toggleMonitor(p.key, false)}><CloseIcon className="monitors-dock__icon" /></button></header>
          <ResizableMonitorBody label={p.label}>
            {p.key === 'automations' && <AutomationsPane tasks={props.tasks} running={props.running} now={props.now} onOpen={props.onOpenChat} />}
            {p.key === 'utilization' && <Utilization providers={props.providers} usage={props.usage} now={props.now} onOpenModels={props.onOpenModels} />}
            {p.key === 'budget' && <Budget usage={props.usage} sessions={props.sessions} providers={props.providers} now={props.now} />}
            {p.key === 'insights' && <InsightsBox budgetMonitorPresent {...insightProps} prefs={state.insights} onPrefs={insights} />}
            {p.key === 'hardware' && <Hardware providers={props.providers} />}
            {p.key === 'localModels' && <LocalModels />}
          </ResizableMonitorBody>
        </section>
          </React.Fragment>;
        })}
        {lift && <LandingZone open={slot === expandedMonitors.length - 1} height={lift.height} />}
        {selectedMonitors.length === 0 && <p className="monitors-dock__empty">No monitors selected. Use Configure to restore them.</p>}
      </div>
    </aside>
    </>
  );
}

/**
 * A dashed drop target between dock monitors. Every gap has one while a monitor is
 * lifted; only the one under the pointer is open, and opening or closing
 * animates its height so the monitors around it slide rather than jump.
 */
function LandingZone({ open, height }: { open: boolean; height: number }) {
  return <div className="monitors-dock__landing" data-open={open ? '' : undefined} aria-hidden="true"
    style={{ '--landing-height': `${Math.round(height)}px` } as React.CSSProperties}><span /></div>;
}

/** Measure natural content independently of the viewport so expansion stops at its end. */
function ResizableMonitorBody({ label, children }: { label: string; children: React.ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  // Dragging writes the height straight onto the viewport and commits once on release.
  const drag = useRef<{ y: number; height: number; last?: number } | null>(null);
  const [natural, setNatural] = useState(420);
  const [requested, setRequested] = useState<number | null>(null);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setNatural(Math.ceil(node.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const min = Math.min(96, natural);
  const height = Math.max(min, Math.min(requested ?? 420, natural));
  const resize = (value: number) => setRequested(Math.max(min, Math.min(natural, value)));
  return <>
    <div ref={viewport} className="monitors-dock__body" style={{ height }}><div ref={content}>{children}</div></div>
    <div className="monitors-dock__monitor-resize" role="separator" tabIndex={0} aria-label={`Resize ${label} monitor height`} aria-orientation="horizontal" aria-valuemin={min} aria-valuemax={natural} aria-valuenow={height} title="Drag to resize; double-click to fit content"
      onPointerDown={(e) => { drag.current = { y: e.clientY, height: viewport.current?.clientHeight ?? height }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = Math.max(min, Math.min(natural, d.height + e.clientY - d.y));
        if (viewport.current) viewport.current.style.height = `${d.last}px`;
      }}
      onPointerUp={() => { const last = drag.current?.last; drag.current = null; if (last != null) resize(last); }} onPointerCancel={() => { drag.current = null; }} onDoubleClick={() => setRequested(natural)}
      onKeyDown={(e) => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { e.preventDefault(); resize(e.key === 'Home' ? min : e.key === 'End' ? natural : height + (e.key === 'ArrowDown' ? 24 : -24)); } }} />
  </>;
}


function Utilization({ providers, usage, now, onOpenModels }: Pick<MonitorsDockProps, 'providers' | 'usage' | 'now' | 'onOpenModels'>) {
  const enabled = utilizationProviders(providers);
  const { byToken, answered, problems, refresh, nextRefreshAt } = useProviderLimitsPortfolio(enabled);
  // Two plans on one vendor (personal and work, say) carry the same label;
  // the signed-in email is what tells them apart.
  const accountEmails = useAccountEmails(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const today = new Date(now).toISOString().slice(0, 10);
  const weekStart = new Date(`${today}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
  const week = weekStart.toISOString().slice(0, 10);
  const todayTokens = usage?.daily.filter((d) => d.date === today).reduce((sum, d) => sum + d.input + d.output, 0);
  const weekDays = usage?.daily.filter((d) => d.date >= week && d.date <= today);
  const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return <div className="monitors-dock__metrics monitors-dock__utilization">
    <div className="monitors-dock__metric-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
    {nextRefreshAt != null && <span className="monitors-dock__note" role="timer">{refreshing ? 'Refreshing…' : `Refreshing in ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s`}</span>}
    <button type="button" className="monitors-dock__text-button justify-self-end" aria-label="Refresh provider quota" title="Pull latest provider quota (provider refreshes are rate limited)" disabled={refreshing} onClick={() => { setRefreshing(true); setRefreshError(null); void refresh().catch(e => setRefreshError(String(e))).finally(() => setRefreshing(false)); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" /></svg></button>
    </div>
    {refreshError && <p role="alert">Could not refresh quota: {refreshError}</p>}
    {enabled.length === 0 && <p>No cloud providers enabled.</p>}
    {enabled.map((provider) => {
      const key = limitsKeyFor(provider);
      const limits = key ? byToken[key] : undefined;
      const windows = limits?.windows ?? [];
      const showRemaining = provider.kind === 'openai' && provider.auth === 'subscription';
      const problem = key && !limits ? problems[key] : undefined;
      // A Claude plan card from an older build: no sign-in to fix it with here.
      const retiredClaudePlan = provider.kind === 'anthropic' && provider.auth === 'subscription' && !oauthProviderOffered('claude');
      const status = retiredClaudePlan ? 'Claude plan sign-in is no longer available. Add an Anthropic API key in Models.'
        : provider.auth === 'subscription' && !provider.tokenKey ? 'Not signed in.'
        : !key ? 'Usage API unavailable.'
        : problem ? describeLimitsProblem(problem, now)
        : !limits ? (answered.has(key) ? 'Quota unavailable.' : 'Reading provider quota…')
        : windows.length === 0 ? 'No quota windows reported.' : null;
      const needsSignIn = problem?.kind === 'auth_expired' || problem?.kind === 'signed_out';
      const email = accountEmailOf(provider, accountEmails);
      return <div key={provider.id} className="monitors-dock__provider" data-limits-problem={problem?.kind}>
        <strong className="monitors-dock__provider-name" title={email ? `${provider.label} · ${email}` : undefined}>{provider.label}{email && <span className="monitors-dock__account" data-account-email> · {email}</span>}</strong>
        {status && <p role={problem ? 'status' : undefined} style={problem ? { color: needsSignIn ? 'var(--danger)' : 'var(--warning)' } : undefined}>{needsSignIn ? signInStatus(problem!.kind) : status}</p>}
        {/* An expired or missing sign-in is fixed right here, with the same
            sign-in the provider card uses, not by a trip to Settings. */}
        {needsSignIn && <DockSignIn provider={provider} onSignedIn={() => { void refresh(); }} />}
        {windows.map((w, i) => {
          const used = Math.max(0, Math.min(100, w.usedPercent));
          const percent = showRemaining ? 100 - used : used;
          const meaning = showRemaining ? 'left' : 'used';
          return <div className="monitors-dock__quota" key={`${w.label}-${i}`}>
          <div className="monitors-dock__metric-row"><span>{w.label}</span><strong>{Number.isFinite(percent) ? `${Math.round(percent)}% ${meaning}` : 'Unavailable'}</strong></div>
          {Number.isFinite(percent) && <div className="monitors-dock__bar" role="meter" aria-label={`${provider.label} ${w.label} ${meaning}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%`, background: used >= 80 ? 'var(--danger)' : used >= 40 ? 'var(--warning)' : 'var(--success)' }} /></div>}
          <p className="monitors-dock__note">{w.resetAt ? w.resetAt <= now ? 'Reset due · awaiting refresh' : `Resets in ${resetPeriod(w.resetAt - now)} · ${new Date(w.resetAt).toLocaleString()}` : 'Reset time unavailable'}</p>
        </div>;
        })}
        {limits?.creditsState === 'balance' && limits.creditsBalance != null && <div className="monitors-dock__metric-row"><span>API usage credits</span><strong>{formatUSD(limits.creditsBalance)}</strong></div>}
        {limits?.creditsState === 'disabled' && <p className="monitors-dock__note">Extra usage credits disabled</p>}
      </div>;
    })}
    <div><div className="monitors-dock__metric-row"><span>Tokens today</span><strong title={todayTokens?.toLocaleString()}>{todayTokens == null ? 'Unavailable' : compact(todayTokens)}</strong></div>
      <p className="monitors-dock__note">{weekDays ? `${compact(weekDays.reduce((sum, d) => sum + d.input, 0))} in · ${compact(weekDays.reduce((sum, d) => sum + d.output, 0))} out this week` : 'Weekly usage unavailable'} · UTC</p></div>
    <button type="button" className="monitors-dock__text-button" onClick={onOpenModels}>Manage providers</button>
  </div>;
}

/** What an expired or missing sign-in says once the fix sits right under it. */
export function signInStatus(kind: string): string {
  return kind === 'signed_out' ? 'Not signed in.' : 'Sign-in expired.';
}

/**
 * Sign in again from the Utilization monitor. A button first, so the monitor stays
 * one line tall until asked; then the same sign-in flow the provider card runs,
 * and the new token is folded onto this provider exactly as the card does.
 */
export function DockSignIn({ provider, onSignedIn }: { provider: ProviderConfig; onSignedIn: () => void }) {
  const oauth = SUBSCRIPTION_KINDS[provider.kind];
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!oauth) return null;
  const name = provider.kind === 'chatgpt' ? 'ChatGPT' : provider.kind === 'openrouter' ? 'OpenRouter' : 'Claude';
  const connected = async (status: OAuthStatus) => {
    try {
      if (provider.tokenKey && provider.tokenKey !== status.tokenKey) await window.nekko.oauthSignOut(provider.id).catch(() => {});
      await window.nekko.saveProvider(provider.auth === 'subscription'
        ? { ...provider, tokenKey: status.tokenKey || provider.tokenKey, accountId: status.accountId ?? provider.accountId }
        : reconnectProviderConfig(provider, status));
      await useStore.getState().refreshProviders();
      useStore.getState().pushToast('success', `Signed in with your ${name} subscription.`);
      setOpen(false);
      onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return <div className="monitors-dock__signin" data-dock-signin>
    {!open
      ? <button type="button" className="btn btn-primary py-1 text-xs" onClick={() => { setError(null); setOpen(true); }}>Sign in again</button>
      : <>
          <SubscriptionSignIn oauthProvider={oauth} label={`Sign in with ${name}`} onConnected={connected} />
          <button type="button" className="monitors-dock__text-button" onClick={() => setOpen(false)}>Cancel</button>
        </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function resetPeriod(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  return `${Math.floor(minutes / 1440)} days ${Math.floor(minutes % 1440 / 60)} hr`;
}

function Budget({ usage, now, sessions, providers }: Pick<MonitorsDockProps, 'usage' | 'now' | 'sessions' | 'providers'>) {
  const benchmark = useStore((s) => s.settings?.localCostBenchmark ?? DEFAULT_LOCAL_COST_BENCHMARK);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The same time ranges as the Insights token chart; defaults to its 1m.
  const [range, setRange] = useState<InsightRange>('1m');
  const ranged = budgetRange(usage, range, new Date(now));
  const spend = ranged?.spend;
  const avoided = ranged?.avoidedCosts;
  const top = Object.entries(ranged?.bySessionCost ?? {}).sort((a, b) => b[1] - a[1])[0];
  const price = getModelPrice(benchmark);
  const comparedModels = (ranged?.modelIds ?? []).map(id => ({ id, price: getModelPrice(id) }));
  const changeBenchmark = async (value: string) => {
    setSaving(true); setError(null);
    try {
      await window.nekko.updateSettings({ localCostBenchmark: value });
      await useStore.getState().refreshSettings();
      window.dispatchEvent(new Event('nekko:usage-refresh'));
    } catch { setError('Could not update cloud comparison. Please try again.'); }
    finally { setSaving(false); }
  };
  return <div className="monitors-dock__metrics monitors-dock__budget">
    <RangeToggles chart="Budget" range={range} onChange={setRange} />
    <div><div className="monitors-dock__metric-row"><span>Spend <small>({BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{spend == null ? 'Unavailable' : formatUSD(spend)}</strong></div><p className="monitors-dock__note">Estimated recorded API spend · UTC · excludes subscriptions</p></div>
    <div className="monitors-dock__metric-row"><span>Tokens <small>({BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{ranged ? `${ranged.input.toLocaleString()} in · ${ranged.output.toLocaleString()} out` : 'Unavailable'}</strong></div>
    <div className="monitors-dock__metric-row"><span>Top agent <small>({BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{top && top[1] > 0 ? `${sessions.find(s => s.id === top[0])?.title ?? 'Chat'} · ${formatUSD(top[1])}` : ranged?.bySessionCost == null ? 'Unavailable' : 'No API spend'}</strong></div>
    <div className="monitors-dock__metric-row"><span>Local models <small>({BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{usage ? '$0 API' : 'Unavailable'} · {ranged?.localTokens == null ? 'Unavailable' : ranged.localTokens.toLocaleString()} tokens</strong></div>
    <div className="monitors-dock__savings">
      <div className="monitors-dock__metric-row"><span>Local AI saved <small>(est. · {BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{avoided ? formatUSD(avoided.local) : 'Unavailable'}</strong></div>
      <div className="monitors-dock__metric-row"><span>Subscription saved <small>(est. · {BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{avoided ? formatUSD(avoided.subscription) : 'Unavailable'}</strong></div>
      <p className="monitors-dock__note">{BUDGET_RANGE_LABEL[range]} API equivalents, before plan fees, hardware and electricity.</p>
    </div>
    <details><summary>Cloud pricing comparison</summary>
      <label className="monitors-dock__benchmark">Fallback for unpriced local models
        <select value={benchmark} disabled={saving} onChange={(e) => void changeBenchmark(e.target.value)}>
          <option value="">None (leave unpriced)</option>
          {MODEL_COMPARISON_TIERS.map(tier => <optgroup key={tier.label} label={tier.label}>
            {tier.models.map(id => { const p = getModelPrice(id); return p && <option key={id} value={id}>{id} · ${p.input} in / ${p.output} out</option>; })}
          </optgroup>)}
          <optgroup label="Legacy comparisons">{MODEL_PRICING.filter(p => !MODEL_COMPARISON_TIERS.some(t => (t.models as readonly string[]).includes(p.match))).map(p => <option key={p.match} value={p.match}>{p.match} · ${p.input} in / ${p.output} out</option>)}</optgroup>
        </select>
      </label>
      <p className="monitors-dock__note">USD per million tokens. Matched models use their published price; the fallback is a comparison, not the same model.</p>
      {price && <p className="monitors-dock__note">Fallback: ${price.input} input / ${price.output} output per 1M tokens.</p>}
      <p className="monitors-dock__note"><a href={MODEL_PRICING_SOURCE} target="_blank" rel="noreferrer">OpenRouter pricing catalog</a> · checked {MODEL_PRICING_CHECKED_AT}. <a href="https://ollama.com/pricing" target="_blank" rel="noreferrer">Ollama cloud rates</a></p>
      <p className="monitors-dock__note">Standard text-token estimates, not invoices. Provider routes, long context, tools and batch rates can differ. Tiers are comparison choices, not verified capability rankings. No monthly plan fees are included.</p>
      {comparedModels.map(({ id, price: p }) => <p className="monitors-dock__note" key={id}>{id}: {p ? `${p.input} input / ${p.output} output per 1M${p.modelId ? ' · exact hosted model' : ' · legacy family estimate'}` : 'No published exact price; local usage uses the selected fallback'}</p>)}
      {!!avoided?.benchmarkTokens && <p className="monitors-dock__note">{avoided.benchmarkTokens.toLocaleString()} local tokens use the fallback.</p>}
    </details>
    {!!avoided?.unpricedTokens && <p className="monitors-dock__note">{avoided.unpricedTokens.toLocaleString()} unpriced tokens excluded from savings.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
/**
 * The Hardware monitor's rows. A temperature, where the machine reports one,
 * sits at the right of its own row's label: the CPU sensor on CPU, DIMM
 * sensors on Memory, each GPU's own reading on its GPU row (the system-wide
 * GPU sensor when the GPU probe has none, e.g. AMD on Linux or Apple Silicon).
 */
export function hardwareRows(monitors: Record<MonitorKind, boolean>, system: SystemStats | null, gpu: GpuStats | null) {
  const memory = (used: number, total: number) => total > 0 ? `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GiB (${Math.round(used / total * 100)}%)` : 'Unavailable';
  const devices: Array<{ name: string; utilizationPct?: number; temperatureC?: number }> = gpu?.devices.length ? gpu.devices : [{ name: '' }];
  return [
    { label: 'CPU', value: !monitors.cpu ? null : system?.cpuPct ?? null, text: !monitors.cpu ? 'Monitor off' : system ? `${system.cpuPct}%` : 'Unavailable', color: 'var(--accent)', temp: monitors.cpu ? system?.temps?.cpuC : undefined },
    { label: 'Memory', value: monitors.memory && system && system.memTotalMB > 0 ? system.memUsedMB / system.memTotalMB * 100 : null, text: !monitors.memory ? 'Monitor off' : system ? memory(system.memUsedMB, system.memTotalMB) : 'Unavailable', color: 'var(--accent-2)', temp: monitors.memory ? system?.temps?.memoryC : undefined },
    ...devices.map((device, index) => {
      const value = monitors.gpu && Number.isFinite(device.utilizationPct) ? device.utilizationPct! : null;
      // A per-device reading wins; the board-level sensor fills in for the only GPU.
      const temp = monitors.gpu ? device.temperatureC ?? (devices.length === 1 ? system?.temps?.gpuC : undefined) : undefined;
      return { label: device.name ? `GPU ${index + 1}: ${device.name}` : 'GPU', value, text: !monitors.gpu ? 'Monitor off' : value == null ? 'Unavailable' : `${value}%`, color: 'var(--success)', temp };
    }),
    { label: gpu ? gpuMemoryLabel(gpu) : 'VRAM', value: monitors.vram && gpu && gpu.totalMB > 0 ? gpu.usedMB / gpu.totalMB * 100 : null, text: !monitors.vram ? 'Monitor off' : gpu ? memory(gpu.usedMB, gpu.totalMB) : 'Unavailable', color: 'var(--warning)', temp: undefined as number | undefined },
  ];
}

const TEMP_COLOR = { ok: 'var(--ink-faint)', warn: 'var(--warning)', hot: 'var(--danger)' } as const;

/** How often the Local models monitor re-reads the engine, matching the chat's model dock. */
const LOCAL_MODELS_POLL_MS = 6000;

/**
 * What the local engine holds in memory and where each model runs, with a jump
 * to that model's own settings on Model Server. Read-only by design: GPU offload,
 * context and KV cache are load-time settings with a reload behind them, and they
 * belong on the page that explains what changing them costs.
 */
export function LocalModels({ initial }: { initial?: { status: EngineStatus | null; models: LocalModel[] } } = {}) {
  const [status, setStatus] = useState<EngineStatus | null>(initial?.status ?? null);
  const [models, setModels] = useState<LocalModel[]>(initial?.models ?? []);
  const [read, setRead] = useState(Boolean(initial));
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const [s, m] = await Promise.all([
        window.nekko.engineStatus().catch(() => null),
        window.nekko.engineModels().catch(() => []),
      ]);
      if (!live) return;
      setStatus(s); setModels(Array.isArray(m) ? m : []); setRead(true);
    };
    void refresh();
    const t = setInterval(refresh, LOCAL_MODELS_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  const store = useStore.getState;
  const names = new Map(models.map((m) => [m.id, m.name]));
  const resident = status?.resident ?? [];
  const openServer = () => store().setView('modelserver');
  if (!read) return <div className="monitors-dock__metrics monitors-dock__local-models"><p className="monitors-dock__note">Reading the local engine…</p></div>;
  return <div className="monitors-dock__metrics monitors-dock__local-models">
    {!status?.install.binPath ? <p>No local engine installed.</p>
      : !status.running ? <p>The model server is stopped.</p>
      : resident.length === 0 ? <p>No local model is loaded.</p>
      : resident.map((r) => {
        const split = r.loadedOn === 'gpu+cpu' || r.loadedOn === 'cpu';
        const name = names.get(r.id) ?? r.id;
        const bytes = r.vramBytes ?? r.sizeBytes;
        const rest = [r.contextLength ? `${formatTokens(r.contextLength)} context` : null, bytes ? formatBytes(bytes) : null].filter((x): x is string => Boolean(x));
        return <div className="monitors-dock__local-model" key={r.id} data-local-model={r.id}>
          <div className="monitors-dock__metric-row">
            <strong className="monitors-dock__provider-name" title={name}>{name}</strong>
            <button type="button" className="monitors-dock__text-button" data-local-model-settings={r.id} title={`Open ${name}'s GPU offload, context and memory settings`} aria-label={`Open ${name} settings`} onClick={() => store().openLocalModelSettings(r.id)}>Settings</button>
          </div>
          <p className="monitors-dock__note">
            {r.loadedOn && <span title={placementTitle(r)} style={split ? { color: 'var(--warning)' } : undefined}>{placementLabel(r)}</span>}
            {r.loadedOn && rest.length > 0 && ' · '}
            {rest.join(' · ')}
          </p>
        </div>;
      })}
    <button type="button" className="monitors-dock__text-button" onClick={openServer}>{status?.install.binPath ? 'Open Model Server' : 'Set up a local model'}</button>
  </div>;
}

function Hardware({ providers }: { providers: ProviderConfig[] }) {
  const monitors = useMonitors();
  const { system, gpu } = useResourceSample();
  const rows = hardwareRows(monitors, system, gpu);
  return <div className="monitors-dock__metrics monitors-dock__hardware">
    {rows.map((row) => <div className="monitors-dock__meter" key={row.label}>
      <div className="monitors-dock__meter-head"><strong>{row.label}</strong>{formatTemperature(row.temp) && <span className="monitors-dock__temp" data-temp-tone={temperatureTone(row.temp!)} style={{ color: TEMP_COLOR[temperatureTone(row.temp!)] }} aria-label={`${row.label} temperature ${formatTemperature(row.temp)}`} title="Sensor temperature"><ThermometerGlyph />{formatTemperature(row.temp)}</span>}</div>
      <div className="monitors-dock__bar" role={row.value == null ? undefined : 'meter'} aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.value == null ? undefined : Math.max(0, Math.min(100, row.value))}>
        {row.value != null && <span style={{ width: `${Math.max(0, Math.min(100, row.value))}%`, background: row.color }} />}
      </div><span className="monitors-dock__reading">{row.text}</span>
    </div>)}
  </div>;
}

function ThermometerGlyph() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z" /></svg>;
}
