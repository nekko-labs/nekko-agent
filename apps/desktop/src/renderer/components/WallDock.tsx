import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AutomationTask, ProviderConfig, RuntimeStatus, SessionSummary, UsageSummary } from '@nekko-agent/shared';
import { RUNTIME_CAPABILITIES, MODEL_PRICING, MODEL_COMPARISON_TIERS, MODEL_PRICING_SOURCE, MODEL_PRICING_CHECKED_AT, getModelPrice, DEFAULT_LOCAL_COST_BENCHMARK, describeLimitsProblem, formatUSD, gpuMemoryLabel, isLocalProvider, limitsKeyFor } from '@nekko-agent/shared';
import { DOCK_PANELS, normalizeDockPanelOrder, placeDockPanel, reorderDockPanel, type CommandWallState, type InsightsPrefs, type WallDockPanel } from '../commandWall.js';
import { useStore } from '../store.js';
import { useProviderLimitsPortfolio } from '../useLimits.js';
import { BUDGET_RANGE_LABEL, budgetRange, localRuntimeMetrics, recordedBudgetMetrics } from './wallDockMetrics.js';
import { AutomationsPane } from './AutomationsPane.js';
import { InsightsBox, type Vitals } from './InsightsBox.js';
import { RangeToggles } from './RangeToggles.js';
import type { InsightRange } from '../insightRanges.js';
import { useMonitors, useResourceSample } from './ResourceMonitor.js';
import { BrainIcon, ServerIcon, MoneyIcon, ListIcon, GearIcon, CloseIcon, MinimizeIcon } from '../icons.js';
import './wallDock.css';
import type { OAuthStatus } from '@nekko-agent/shared';
import { SubscriptionSignIn } from './SubscriptionSignIn.js';
import { SUBSCRIPTION_KINDS, reconnectProviderConfig } from './providers/AddProvider.js';
import { dockMinimizeTransition } from './dockMinimize.js';

const PANEL_ICONS = { automations: GearIcon, utilization: ListIcon, budget: MoneyIcon, insights: BrainIcon, hardware: ServerIcon };

export interface WallDockProps {
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

const DEFAULT_DOCK_WIDTH = 408;

/** A flow-layout sibling of the wall stage. The parent places it using data-dock-side. */
export function WallDock(props: WallDockProps) {
  const { state, setState } = props;
  const { dock } = state;
  const reorderDrag = useRef<WallDockPanel | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const sideDock = dock.side === 'left' || dock.side === 'right';
  const reorder = (key: WallDockPanel, target: WallDockPanel) => {
    setState((s) => ({ ...s, dock: { ...s.dock, panelOrder: reorderDockPanel(s.dock.panelOrder, key, target) } }));
    setReorderAnnouncement(`${DOCK_PANELS.find(p => p.key === key)!.label} moved ${normalizeDockPanelOrder(dock.panelOrder).indexOf(key) < normalizeDockPanelOrder(dock.panelOrder).indexOf(target) ? 'down' : 'up'}.`);
  };
  // Drag to reorder: the lifted panel leaves the column and a dashed landing
  // zone of its height opens where it would land. Zones sit before each other
  // panel (and at the end) and grow or shrink with a transition, so neighbours
  // slide apart rather than jump. On drop the panel flies from the pointer
  // into the zone it fills.
  const [lift, setLift] = useState<{ key: WallDockPanel; height: number } | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  // The first zone opens without a transition, in the lifted panel's own place.
  const [lifting, setLifting] = useState(false);
  useEffect(() => {
    if (!lifting) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setLifting(false)));
    return () => cancelAnimationFrame(frame);
  }, [lifting]);
  const grab = useRef({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 });
  const liftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelsRef = useRef<HTMLDivElement>(null);
  const landed = useRef<{ key: WallDockPanel; x: number; y: number } | null>(null);
  useEffect(() => () => clearTimeout(liftTimer.current), []);
  /** Where the pointer sits among the panels still in the column: before the first panel whose middle is below it. */
  const slotAt = (y: number) => {
    const rest = [...(panelsRef.current?.querySelectorAll<HTMLElement>('[data-dock-panel]:not([data-dock-lifted])') ?? [])];
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
  // After a drop (or a cancelled drag) the panel is back in the column: start
  // it where the dragged ghost was and let it settle into its new place.
  useLayoutEffect(() => {
    const flight = landed.current;
    if (!flight || lift) return;
    landed.current = null;
    const node = panelsRef.current?.querySelector<HTMLElement>(`[data-dock-panel="${flight.key}"]`);
    if (!node || typeof node.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = node.getBoundingClientRect();
    const dx = flight.x - grab.current.x - r.left;
    const dy = flight.y - grab.current.y - r.top;
    if (Math.hypot(dx, dy) < 2) return;
    node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(1.02)`, boxShadow: '0 14px 30px -14px rgb(0 0 0 / .5)' },
      { transform: 'none', boxShadow: '0 0 0 0 rgb(0 0 0 / 0)' },
    ], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }, [lift]);
  const [width, setWidth] = useState(DEFAULT_DOCK_WIDTH);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const size = (value: number) => { const next = Math.max(260, Math.min(600, value)); setWidth(Math.abs(next - DEFAULT_DOCK_WIDTH) <= 20 ? DEFAULT_DOCK_WIDTH : next); };
  const [collapsing, setCollapsing] = useState<WallDockPanel | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const focusPanel = useRef<{ key: WallDockPanel; minimized: boolean } | null>(null);
  const minimizeTransition = useRef(dockMinimizeTransition());
  useEffect(() => () => minimizeTransition.current.cancel(), []);
  useEffect(() => {
    const pending = focusPanel.current;
    if (!pending || Boolean(dock.minimized[pending.key]) !== pending.minimized) return;
    const label = DOCK_PANELS.find(p => p.key === pending.key)!.label;
    dockRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="${pending.minimized ? 'Expand' : 'Minimize'} ${label} panel"]`)?.focus();
    focusPanel.current = null;
  }, [dock.minimized]);
  const [configure, setConfigure] = useState(false);
  const configureRef = useRef<HTMLDivElement>(null);
  const configureButton = useRef<HTMLButtonElement>(null);
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
  const panel = (key: WallDockPanel, enabled: boolean) => setState((s) => ({ ...s, dock: { ...s.dock, panels: { ...s.dock.panels, [key]: enabled } } }));
  const insights = (prefs: InsightsPrefs) => setState((s) => ({ ...s, insights: prefs }));
  const insightProps = { usage: props.usage, sessions: props.sessions, providers: props.providers, vitals: props.vitals, onOpenModels: props.onOpenModels };

  const minimize = (key: WallDockPanel, value: boolean) => {
    minimizeTransition.current.cancel();
    const commit = () => {
      focusPanel.current = { key, minimized: value };
      setState((s) => ({ ...s, dock: { ...s.dock, minimized: { ...s.dock.minimized, [key]: value } } }));
      setCollapsing(null);
    };
    minimizeTransition.current.start(!value || window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => setCollapsing(key), commit);
  };

  // The wall toolbar owns visibility and restores the hidden dock.
  if (!dock.show) return null;
  const selectedPanels = normalizeDockPanelOrder(dock.panelOrder).map(key => DOCK_PANELS.find(p => p.key === key)!).filter((p) => dock.panels[p.key]);
  const expandedPanels = selectedPanels.filter((p) => !dock.minimized[p.key]);
  return (
    <aside ref={dockRef} className="wall-dock" style={{ '--dock-width': `${width}px` } as React.CSSProperties} data-dock-side={dock.side} aria-label="Dashboard dock">
      {(dock.side === 'left' || dock.side === 'right') && <div className="wall-dock__resize" role="separator" tabIndex={0} aria-label="Resize panels" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={600} aria-valuenow={width} title="Drag to resize panels; double-click to reset"
        onPointerDown={(e) => { drag.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) size(Math.min((e.currentTarget.parentElement?.parentElement?.clientWidth ?? 1000) - 240, drag.current.width + (e.clientX - drag.current.x) * (dock.side === 'left' ? 1 : -1))); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onDoubleClick={() => setWidth(DEFAULT_DOCK_WIDTH)}
        onKeyDown={(e) => { if (e.key === 'Home') { e.preventDefault(); setWidth(DEFAULT_DOCK_WIDTH); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); size(width + (e.key === 'ArrowRight' ? 24 : -24) * (dock.side === 'left' ? 1 : -1)); } }} />}
      <header className="wall-dock__toolbar">
        <strong>Panels</strong>
        <span className="wall-dock__count">{selectedPanels.length} of {DOCK_PANELS.length}</span>
        <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{reorderAnnouncement}</span>
        <div className="wall-dock__configure" ref={configureRef}>
          <button type="button" ref={configureButton} aria-expanded={configure} onClick={() => setConfigure((v) => !v)} title="Configure panels" aria-label="Configure panels"><GearIcon className="wall-dock__icon" /> Configure</button>
          {configure && <div className="wall-dock__popover" role="group" aria-label="Dock configuration">
            <fieldset><legend>Position</legend><div className="wall-dock__positions">
              {(['left', 'right', 'top', 'bottom'] as const).map((side) => <button type="button" key={side} aria-pressed={dock.side === side} onClick={() => patch({ side })}>{side[0].toUpperCase() + side.slice(1)}</button>)}
            </div></fieldset>
            <fieldset><legend>Panels</legend>{DOCK_PANELS.map((p) => <label key={p.key}><input type="checkbox" checked={dock.panels[p.key]} onChange={(e) => panel(p.key, e.target.checked)} /><span className="wall-dock__option"><strong>{p.label}</strong><span>{p.blurb}</span></span></label>)}</fieldset>
          </div>}
        </div>
      </header>
      {selectedPanels.some((p) => dock.minimized[p.key]) && <div className="wall-dock__minimized" role="group" aria-label="Minimized panels">
        {selectedPanels.filter((p) => dock.minimized[p.key]).map((p) => { const Icon = PANEL_ICONS[p.key]; return <button key={p.key} type="button" title={`Restore ${p.label}`} aria-label={`Expand ${p.label} panel`} aria-expanded={false} onClick={() => minimize(p.key, false)}><Icon className="wall-dock__icon" /></button>; })}
      </div>}
      <div ref={panelsRef} className="wall-dock__panels" data-dock-dragging={lift ? '' : undefined} data-dock-lifting={lifting ? '' : undefined}
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
          const rest = expandedPanels.filter((p) => p.key !== key);
          const at = Math.min(slot ?? slotAt(e.clientY), rest.length);
          const anchor = rest[at] ?? rest[rest.length - 1];
          if (anchor) {
            const where = rest[at] ? 'before' : 'after';
            setState((s) => ({ ...s, dock: { ...s.dock, panelOrder: placeDockPanel(s.dock.panelOrder, key, anchor.key, where) } }));
            const before = expandedPanels.findIndex((p) => p.key === key);
            if (at !== before) setReorderAnnouncement(`${DOCK_PANELS.find((p) => p.key === key)!.label} moved ${at > before ? 'down' : 'up'}.`);
          }
          endDrag({ x: e.clientX, y: e.clientY });
        }}>
        {expandedPanels.map((p) => {
          const lifted = lift?.key === p.key;
          const restIndex = expandedPanels.filter((q) => q.key !== lift?.key).findIndex((q) => q.key === p.key);
          return <React.Fragment key={p.key}>
          {lift && !lifted && <LandingZone open={slot === restIndex} height={lift.height} />}
          <section className={`wall-dock__panel${collapsing === p.key ? ' wall-dock__panel--collapsing' : ''}`} data-dock-panel={p.key} data-dock-lifted={lifted ? '' : undefined} aria-label={`${p.label} dock panel`}>
          <header className="wall-dock__panel-header" draggable={sideDock && collapsing === null} tabIndex={sideDock ? 0 : undefined}
            aria-label={sideDock ? `${p.label} panel header; use Alt+ArrowUp or Alt+ArrowDown to reorder` : undefined}
            title={sideDock ? 'Drag header to reorder; Alt+ArrowUp/Down moves this panel' : undefined}
            onDragStart={(e) => {
              if (!sideDock || collapsing !== null || (e.target as HTMLElement).closest('button')) { e.preventDefault(); return; }
              reorderDrag.current = p.key;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-nekko-dock-panel', p.key);
              e.stopPropagation();
              // The whole panel follows the pointer, not just its header.
              const section = e.currentTarget.parentElement!;
              const r = section.getBoundingClientRect();
              grab.current = { x: e.clientX - r.left, y: e.clientY - r.top };
              pointer.current = { x: e.clientX, y: e.clientY };
              e.dataTransfer.setDragImage?.(section, grab.current.x, grab.current.y);
              // Lift on the next task: hiding the source inside dragstart
              // cancels the drag in Chromium. The zone opens where the panel
              // was, at its height, so nothing below it moves yet.
              const height = r.height;
              const from = expandedPanels.findIndex((q) => q.key === p.key);
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
              const target = expandedPanels[expandedPanels.findIndex(panel => panel.key === p.key) + (e.key === 'ArrowDown' ? 1 : -1)];
              if (target) reorder(p.key, target.key);
            }}><span aria-hidden="true" title="Drag to reorder" className="text-ink-faint">⠿</span><span className="wall-dock__panel-icon">{React.createElement(PANEL_ICONS[p.key], { className: 'wall-dock__icon' })}</span><h2>{p.label}</h2><button type="button" title={`Minimize ${p.label}`} aria-label={`Minimize ${p.label} panel`} aria-expanded={true} disabled={collapsing !== null} onClick={() => minimize(p.key, true)}><MinimizeIcon className="wall-dock__icon" /></button><button type="button" title={`Remove ${p.label}`} aria-label={`Remove ${p.label} panel`} onClick={() => panel(p.key, false)}><CloseIcon className="wall-dock__icon" /></button></header>
          <ResizablePanelBody label={p.label}>
            {p.key === 'automations' && <AutomationsPane tasks={props.tasks} running={props.running} now={props.now} onOpen={props.onOpenChat} />}
            {p.key === 'utilization' && <Utilization providers={props.providers} usage={props.usage} now={props.now} onOpenModels={props.onOpenModels} />}
            {p.key === 'budget' && <Budget usage={props.usage} sessions={props.sessions} providers={props.providers} now={props.now} />}
            {p.key === 'insights' && <InsightsBox budgetPanelPresent {...insightProps} prefs={state.insights} onPrefs={insights} />}
            {p.key === 'hardware' && <Hardware providers={props.providers} />}
          </ResizablePanelBody>
        </section>
          </React.Fragment>;
        })}
        {lift && <LandingZone open={slot === expandedPanels.length - 1} height={lift.height} />}
        {selectedPanels.length === 0 && <p className="wall-dock__empty">No panels selected. Use Configure to restore them.</p>}
      </div>
    </aside>
  );
}

/**
 * A dashed drop target between dock panels. Every gap has one while a panel is
 * lifted; only the one under the pointer is open, and opening or closing
 * animates its height so the panels around it slide rather than jump.
 */
function LandingZone({ open, height }: { open: boolean; height: number }) {
  return <div className="wall-dock__landing" data-open={open ? '' : undefined} aria-hidden="true"
    style={{ '--landing-height': `${Math.round(height)}px` } as React.CSSProperties}><span /></div>;
}

/** Measure natural content independently of the viewport so expansion stops at its end. */
function ResizablePanelBody({ label, children }: { label: string; children: React.ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
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
    <div ref={viewport} className="wall-dock__body" style={{ height }}><div ref={content}>{children}</div></div>
    <div className="wall-dock__panel-resize" role="separator" tabIndex={0} aria-label={`Resize ${label} panel height`} aria-orientation="horizontal" aria-valuemin={min} aria-valuemax={natural} aria-valuenow={height} title="Drag to resize; double-click to fit content"
      onPointerDown={(e) => { drag.current = { y: e.clientY, height: viewport.current?.clientHeight ?? height }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (drag.current) resize(drag.current.height + e.clientY - drag.current.y); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onDoubleClick={() => setRequested(natural)}
      onKeyDown={(e) => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { e.preventDefault(); resize(e.key === 'Home' ? min : e.key === 'End' ? natural : height + (e.key === 'ArrowDown' ? 24 : -24)); } }} />
  </>;
}


function Utilization({ providers, usage, now, onOpenModels }: Pick<WallDockProps, 'providers' | 'usage' | 'now' | 'onOpenModels'>) {
  const enabled = providers.filter((p) => p.enabled && !isLocalProvider(p.kind));
  const { byToken, answered, problems, refresh, nextRefreshAt } = useProviderLimitsPortfolio(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const today = new Date(now).toISOString().slice(0, 10);
  const weekStart = new Date(`${today}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
  const week = weekStart.toISOString().slice(0, 10);
  const todayTokens = usage?.daily.filter((d) => d.date === today).reduce((sum, d) => sum + d.input + d.output, 0);
  const weekDays = usage?.daily.filter((d) => d.date >= week && d.date <= today);
  const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return <div className="wall-dock__metrics wall-dock__utilization">
    <div className="wall-dock__metric-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
    {nextRefreshAt != null && <span className="wall-dock__note" role="timer">{refreshing ? 'Refreshing…' : `Refreshing in ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s`}</span>}
    <button type="button" className="wall-dock__text-button justify-self-end" aria-label="Refresh provider quota" title="Pull latest provider quota (provider refreshes are rate limited)" disabled={refreshing} onClick={() => { setRefreshing(true); setRefreshError(null); void refresh().catch(e => setRefreshError(String(e))).finally(() => setRefreshing(false)); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2" /></svg></button>
    </div>
    {refreshError && <p role="alert">Could not refresh quota: {refreshError}</p>}
    {enabled.length === 0 && <p>No cloud providers enabled.</p>}
    {enabled.map((provider) => {
      const key = limitsKeyFor(provider);
      const limits = key ? byToken[key] : undefined;
      const windows = limits?.windows ?? [];
      const showRemaining = provider.kind === 'openai' && provider.auth === 'subscription';
      const problem = key && !limits ? problems[key] : undefined;
      const status = provider.auth === 'subscription' && !provider.tokenKey ? 'Not signed in.'
        : !key ? 'Usage API unavailable.'
        : problem ? describeLimitsProblem(problem, now)
        : !limits ? (answered.has(key) ? 'Quota unavailable.' : 'Reading provider quota…')
        : windows.length === 0 ? 'No quota windows reported.' : null;
      const needsSignIn = problem?.kind === 'auth_expired' || problem?.kind === 'signed_out';
      return <div key={provider.id} className="wall-dock__provider" data-limits-problem={problem?.kind}>
        <strong>{provider.label}</strong>
        {status && <p role={problem ? 'status' : undefined} style={problem ? { color: needsSignIn ? 'var(--danger)' : 'var(--warning)' } : undefined}>{needsSignIn ? signInStatus(problem!.kind) : status}</p>}
        {/* An expired or missing sign-in is fixed right here, with the same
            sign-in the provider card uses, not by a trip to Settings. */}
        {needsSignIn && <DockSignIn provider={provider} onSignedIn={() => { void refresh(); }} />}
        {windows.map((w, i) => {
          const used = Math.max(0, Math.min(100, w.usedPercent));
          const percent = showRemaining ? 100 - used : used;
          const meaning = showRemaining ? 'left' : 'used';
          return <div className="wall-dock__quota" key={`${w.label}-${i}`}>
          <div className="wall-dock__metric-row"><span>{w.label}</span><strong>{Number.isFinite(percent) ? `${Math.round(percent)}% ${meaning}` : 'Unavailable'}</strong></div>
          {Number.isFinite(percent) && <div className="wall-dock__bar" role="meter" aria-label={`${provider.label} ${w.label} ${meaning}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%`, background: used >= 80 ? 'var(--danger)' : used >= 40 ? 'var(--warning)' : 'var(--success)' }} /></div>}
          <p className="wall-dock__note">{w.resetAt ? w.resetAt <= now ? 'Reset due · awaiting refresh' : `Resets in ${resetPeriod(w.resetAt - now)} · ${new Date(w.resetAt).toLocaleString()}` : 'Reset time unavailable'}</p>
        </div>;
        })}
        {limits?.creditsState === 'balance' && limits.creditsBalance != null && <div className="wall-dock__metric-row"><span>API usage credits</span><strong>{formatUSD(limits.creditsBalance)}</strong></div>}
        {limits?.creditsState === 'disabled' && <p className="wall-dock__note">Extra usage credits disabled</p>}
      </div>;
    })}
    <div><div className="wall-dock__metric-row"><span>Tokens today</span><strong title={todayTokens?.toLocaleString()}>{todayTokens == null ? 'Unavailable' : compact(todayTokens)}</strong></div>
      <p className="wall-dock__note">{weekDays ? `${compact(weekDays.reduce((sum, d) => sum + d.input, 0))} in · ${compact(weekDays.reduce((sum, d) => sum + d.output, 0))} out this week` : 'Weekly usage unavailable'} · UTC</p></div>
    <button type="button" className="wall-dock__text-button" onClick={onOpenModels}>Manage providers</button>
  </div>;
}

/** What an expired or missing sign-in says once the fix sits right under it. */
export function signInStatus(kind: string): string {
  return kind === 'signed_out' ? 'Not signed in.' : 'Sign-in expired.';
}

/**
 * Sign in again from the Utilization panel. A button first, so the panel stays
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
  return <div className="wall-dock__signin" data-dock-signin>
    {!open
      ? <button type="button" className="btn btn-primary py-1 text-[12px]" onClick={() => { setError(null); setOpen(true); }}>Sign in again</button>
      : <>
          <SubscriptionSignIn oauthProvider={oauth} label={`Sign in with ${name}`} onConnected={connected} />
          <button type="button" className="wall-dock__text-button" onClick={() => setOpen(false)}>Cancel</button>
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

function Budget({ usage, now, sessions, providers }: Pick<WallDockProps, 'usage' | 'now' | 'sessions' | 'providers'>) {
  const benchmark = useStore((s) => s.settings?.localCostBenchmark ?? DEFAULT_LOCAL_COST_BENCHMARK);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The same time ranges as the Insights token chart; defaults to its 1m.
  const [range, setRange] = useState<InsightRange>('1m');
  const recorded = recordedBudgetMetrics(usage, sessions, providers);
  const ranged = budgetRange(usage, range, new Date(now));
  const spend = ranged?.spend;
  const avoided = usage?.avoidedCosts;
  const top = Object.entries(usage?.bySessionCost ?? {}).sort((a, b) => b[1] - a[1])[0];
  const price = getModelPrice(benchmark);
  const comparedModels = Object.keys(usage?.byModel ?? {}).map(id => ({ id, price: getModelPrice(id) }));
  const changeBenchmark = async (value: string) => {
    setSaving(true); setError(null);
    try {
      await window.nekko.updateSettings({ localCostBenchmark: value });
      await useStore.getState().refreshSettings();
      window.dispatchEvent(new Event('nekko:usage-refresh'));
    } catch { setError('Could not update cloud comparison. Please try again.'); }
    finally { setSaving(false); }
  };
  return <div className="wall-dock__metrics wall-dock__budget">
    <RangeToggles chart="Budget" range={range} onChange={setRange} />
    <div><div className="wall-dock__metric-row"><span>Spend <small>({BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{spend == null ? 'Unavailable' : formatUSD(spend)}</strong></div><p className="wall-dock__note">Estimated recorded API spend · UTC · excludes subscriptions</p></div>
    <div className="wall-dock__metric-row"><span>Tokens <small>({BUDGET_RANGE_LABEL[range].toLowerCase()})</small></span><strong>{ranged ? `${ranged.input.toLocaleString()} in · ${ranged.output.toLocaleString()} out` : 'Unavailable'}</strong></div>
    <div className="wall-dock__metric-row"><span>Top agent <small>(all time)</small></span><strong>{top && top[1] > 0 ? `${sessions.find(s => s.id === top[0])?.title ?? 'Chat'} · ${formatUSD(top[1])}` : 'No API spend'}</strong></div>
    <div className="wall-dock__metric-row"><span>Local models</span><strong>{usage ? '$0 API' : 'Unavailable'} · {recorded.localTokens} tokens</strong></div>
    <div className="wall-dock__savings">
      <div className="wall-dock__metric-row"><span>Local AI saved <small>(est.)</small></span><strong>{avoided ? formatUSD(avoided.local) : 'Unavailable'}</strong></div>
      <div className="wall-dock__metric-row"><span>Subscription saved <small>(est. · all time)</small></span><strong>{avoided ? formatUSD(avoided.subscription) : 'Unavailable'}</strong></div>
      <p className="wall-dock__note">All-time API equivalents, before plan fees, hardware and electricity.</p>
    </div>
    <details><summary>Cloud pricing comparison</summary>
      <label className="wall-dock__benchmark">Fallback for unpriced local models
        <select value={benchmark} disabled={saving} onChange={(e) => void changeBenchmark(e.target.value)}>
          <option value="">None (leave unpriced)</option>
          {MODEL_COMPARISON_TIERS.map(tier => <optgroup key={tier.label} label={tier.label}>
            {tier.models.map(id => { const p = getModelPrice(id); return p && <option key={id} value={id}>{id} · ${p.input} in / ${p.output} out</option>; })}
          </optgroup>)}
          <optgroup label="Legacy comparisons">{MODEL_PRICING.filter(p => !MODEL_COMPARISON_TIERS.some(t => (t.models as readonly string[]).includes(p.match))).map(p => <option key={p.match} value={p.match}>{p.match} · ${p.input} in / ${p.output} out</option>)}</optgroup>
        </select>
      </label>
      <p className="wall-dock__note">USD per million tokens. Matched models use their published price; the fallback is a comparison, not the same model.</p>
      {price && <p className="wall-dock__note">Fallback: ${price.input} input / ${price.output} output per 1M tokens.</p>}
      <p className="wall-dock__note"><a href={MODEL_PRICING_SOURCE} target="_blank" rel="noreferrer">OpenRouter pricing catalog</a> · checked {MODEL_PRICING_CHECKED_AT}. <a href="https://ollama.com/pricing" target="_blank" rel="noreferrer">Ollama cloud rates</a></p>
      <p className="wall-dock__note">Standard text-token estimates, not invoices. Provider routes, long context, tools and batch rates can differ. Tiers are comparison choices, not verified capability rankings. No monthly plan fees are included.</p>
      {comparedModels.map(({ id, price: p }) => <p className="wall-dock__note" key={id}>{id}: {p ? `${p.input} input / ${p.output} output per 1M${p.modelId ? ' · exact hosted model' : ' · legacy family estimate'}` : 'No published exact price; local usage uses the selected fallback'}</p>)}
      {!!avoided?.benchmarkTokens && <p className="wall-dock__note">{avoided.benchmarkTokens.toLocaleString()} local tokens use the fallback.</p>}
    </details>
    {!!avoided?.unpricedTokens && <p className="wall-dock__note">{avoided.unpricedTokens.toLocaleString()} unpriced tokens excluded from savings.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
function Hardware({ providers }: { providers: ProviderConfig[] }) {
  const monitors = useMonitors();
  const { system, gpu } = useResourceSample();
  const memory = (used: number, total: number) => total > 0 ? `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GiB (${Math.round(used / total * 100)}%)` : 'Unavailable';
  const rows = [
    { label: 'CPU', value: !monitors.cpu ? null : system?.cpuPct ?? null, text: !monitors.cpu ? 'Monitor off' : system ? `${system.cpuPct}%` : 'Unavailable', color: 'var(--accent)' },
    { label: 'Memory', value: monitors.memory && system && system.memTotalMB > 0 ? system.memUsedMB / system.memTotalMB * 100 : null, text: !monitors.memory ? 'Monitor off' : system ? memory(system.memUsedMB, system.memTotalMB) : 'Unavailable', color: 'var(--accent-2)' },
    ...(gpu?.devices.length ? gpu.devices : [{ name: '', utilizationPct: undefined }]).map((device, index) => {
      const value = monitors.gpu && Number.isFinite(device.utilizationPct) ? device.utilizationPct! : null;
      return { label: device.name ? `GPU ${index + 1}: ${device.name}` : 'GPU', value, text: !monitors.gpu ? 'Monitor off' : value == null ? 'Unavailable' : `${value}%`, color: 'var(--success)' };
    }),
    { label: gpu ? gpuMemoryLabel(gpu) : 'VRAM', value: monitors.vram && gpu && gpu.totalMB > 0 ? gpu.usedMB / gpu.totalMB * 100 : null, text: !monitors.vram ? 'Monitor off' : gpu ? memory(gpu.usedMB, gpu.totalMB) : 'Unavailable', color: 'var(--warning)' },
  ];
  return <div className="wall-dock__metrics wall-dock__hardware">
    {rows.map((row) => <div className="wall-dock__meter" key={row.label}>
      <strong>{row.label}</strong>
      <div className="wall-dock__bar" role={row.value == null ? undefined : 'meter'} aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.value == null ? undefined : Math.max(0, Math.min(100, row.value))}>
        {row.value != null && <span style={{ width: `${Math.max(0, Math.min(100, row.value))}%`, background: row.color }} />}
      </div><span className="wall-dock__reading">{row.text}</span>
    </div>)}
  </div>;
}
