import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderConfig, RemoteStatus, ReplyStop, SessionSummary, UsageSummary } from '@nekko-agent/shared';
import type { AgentType, OptimizationTip } from '@nekko-agent/shared';
import { estimateCostUSD, formatUSD, isLocalProvider, DEFAULT_LOCAL_COST_BENCHMARK, MODEL_PRICING, optimizationTips } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { INSIGHT_PANELS, type InsightPanel, type InsightsPrefs } from '../commandWall.js';
import { PaneActions, useInPaneFrame } from './PaneFrame.js';
import { Badge, EmptyHint } from './primitives/index.js';
import { CheckIcon, GearIcon, ServerIcon } from '../icons.js';
import { EmptyArea, InsightsEmptyArt } from './EmptyIllustrations.js';
import { insightDays, type InsightRange } from '../insightRanges.js';
import { RangeToggles } from './RangeToggles.js';

/** The machine's at-a-glance numbers, computed by the view from live state. */
export interface Vitals {
  working: number;
  waiting: number;
  automations: number;
  terminals: number;
  tokensToday: number;
  spend: string;
  fleet: Array<{ type: AgentType; count: number; live: number }>;
}

/**
 * The Agent board's analytics: the panels the user ticked in the gear menu,
 * flowing into as many columns as the box is wide enough for, so the same box
 * reads as a strip in a narrow window and a dashboard in a wide one. On the
 * wall it is a window like any other (the gear rides in the window's strip);
 * anywhere else it draws its own header.
 */
export function InsightsBox({
  budgetMonitorPresent = false,
  prefs,
  onPrefs,
  usage,
  sessions,
  providers,
  vitals,
  onOpenModels,
}: {
  budgetMonitorPresent?: boolean;
  prefs: InsightsPrefs;
  onPrefs: (next: InsightsPrefs) => void;
  usage: UsageSummary | null;
  sessions: SessionSummary[];
  providers: ProviderConfig[];
  vitals: Vitals;
  onOpenModels: () => void;
}) {
  const tips = useMemo(() => optimizationTips({ usage, sessions, providers }), [usage, sessions, providers]);
  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!gearOpen) return;
    const onDown = (e: MouseEvent) => { if (!gearRef.current?.contains(e.target as Node)) setGearOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setGearOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [gearOpen]);

  const on = (key: InsightPanel) => prefs.panels[key] && !(budgetMonitorPresent && (key === 'cost' || key === 'optimize'));
  const availablePanels = INSIGHT_PANELS.filter(p => !budgetMonitorPresent || (p.key !== 'cost' && p.key !== 'optimize'));
  const toggle = (key: InsightPanel) => onPrefs({ ...prefs, panels: { ...prefs.panels, [key]: !prefs.panels[key] } });
  const hasUsage = !!usage && (usage.totalInput + usage.totalOutput > 0 || !!usage.hasSubscriptionUsage);
  const shown = availablePanels.filter((p) => on(p.key)).length;

  const framed = useInPaneFrame();
  const gear = (
    <div className="relative" ref={gearRef}>
      <button
        className={`rounded-md p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink ${gearOpen ? 'bg-surface-2 text-ink' : ''}`}
        title="Choose which stats and charts to show"
        aria-label="Insights settings"
        aria-expanded={gearOpen}
        onClick={() => setGearOpen((o) => !o)}
      >
        <GearIcon className="h-4 w-4" />
      </button>
      {gearOpen && (
        <div className="card absolute right-0 top-9 z-30 w-72 p-2 shadow-(--shadow-float)" style={{ background: 'var(--paper)' }} role="menu">
          <p className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">Show</p>
          {availablePanels.map((p) => (
            <label key={p.key} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
              <input type="checkbox" className="mt-0.5" checked={on(p.key)} onChange={() => toggle(p.key)} />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{p.label}</span>
                <span className="block text-2xs text-ink-faint">{p.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className={framed ? 'relative h-full min-h-0 overflow-y-auto p-3' : 'card relative p-4'} data-insights-box>
      {framed ? (
        <PaneActions>{gear}</PaneActions>
      ) : (
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Insights</h2>
          <span className="text-xs text-ink-faint">{shown === 0 ? 'nothing selected, open the gear' : ''}</span>
          <div className="ml-auto flex items-center gap-0.5">{gear}</div>
        </div>
      )}

      {on('vitals') && <VitalsStrip vitals={vitals} hideCost={budgetMonitorPresent} />}
      {framed && shown === 0 && <p className="text-xs text-ink-faint">Nothing selected. Open the gear in this window's strip to pick stats and charts.</p>}

      {!hasUsage && shown > (on('vitals') ? 1 : 0) ? (
        <EmptyArea className="mt-3" art={<InsightsEmptyArt />} title="No usage to chart yet">
          Start a chat and the tokens, spend, replies and tips show up here, day by day.
        </EmptyArea>
      ) : (
        <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}>
          {on('optimize') && hasUsage && <div style={{ gridColumn: '1 / -1' }}><OptimizePanel tips={tips} onOpenModels={onOpenModels} /></div>}
          {on('cost') && hasUsage && <CostPanel usage={usage} sessions={sessions} providers={providers} />}
          {on('tokens') && hasUsage && <TokensPanel usage={usage} />}
          {on('models') && hasUsage && <ModelsPanel usage={usage} hideCost={budgetMonitorPresent} />}
          {on('replies') && hasUsage && <RepliesPanel usage={usage} sessions={sessions} />}
          {on('services') && <div style={{ gridColumn: '1 / -1' }}><ServicesPanel providers={providers} usage={usage} /></div>}
        </div>
      )}
    </section>
  );
}

/* ---------- vitals ---------- */

function VitalsStrip({ vitals, hideCost = false }: { vitals: Vitals; hideCost?: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-line py-2.5 text-xs text-ink-faint">
      <Stat live={vitals.working > 0} value={vitals.working} label={vitals.working === 1 ? 'agent working' : 'agents working'} />
      <StatDivider />
      <Stat value={vitals.waiting} label="waiting on you" tone={vitals.waiting > 0 ? 'var(--warning)' : undefined} />
      <StatDivider />
      <Stat value={vitals.automations} label="automations active" />
      <StatDivider />
      <Stat value={vitals.terminals} label={vitals.terminals === 1 ? 'terminal live' : 'terminals live'} />
      <StatDivider />
      <Stat value={vitals.tokensToday.toLocaleString()} label="tokens today" />
      <StatDivider />
      {!hideCost && <Stat value={vitals.spend} label="est. spend" />}
      {vitals.fleet.length > 0 && (
        <span className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {vitals.fleet.map((g) => (
            <span key={g.type.role} className="flex items-center gap-1" title={`${g.count} ${g.type.label}${g.count === 1 ? '' : 's'}${g.live > 0 ? `, ${g.live} working` : ''}`}>
              <span>{g.type.icon}</span>
              <span className="tabular-nums">{g.live > 0 ? `${g.live}/${g.count}` : g.count}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

export function Stat({ value, label, live, tone }: { value: number | string; label: string; live?: boolean; tone?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {live != null && (
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse' : ''}`} style={{ background: live ? 'var(--success)' : 'var(--ink-faint)' }} />
      )}
      <span className="tabular-nums font-semibold text-ink" style={tone ? { color: tone } : undefined}>{value}</span>
      <span style={tone ? { color: tone } : undefined}>{label}</span>
    </span>
  );
}

export function StatDivider() {
  return <span aria-hidden className="h-3 w-px" style={{ background: 'var(--line)' }} />;
}

/* ---------- panels ---------- */

const TIP_STYLE: Record<OptimizationTip['severity'], { color: string; icon: string; label: string }> = {
  warn: { color: 'var(--warning)', icon: '!', label: 'Heads up' },
  suggest: { color: 'var(--success)', icon: '↳', label: 'Suggestion' },
  info: { color: 'var(--info)', icon: 'i', label: 'Insight' },
};

function PanelTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="text-xs font-semibold">{children}</h3>
      {aside && <span className="text-2xs text-ink-faint">{aside}</span>}
    </div>
  );
}

function OptimizePanel({ tips, onOpenModels }: { tips: OptimizationTip[]; onOpenModels: () => void }) {
  const totalSaving = tips.reduce((s, t) => s + (t.saving ?? 0), 0);
  return (
    <div>
      <PanelTitle aside={tips.length === 0 ? 'your usage looks lean' : totalSaving > 0.01 ? `~${formatUSD(totalSaving)} potential savings` : `${tips.length} tip${tips.length === 1 ? '' : 's'}`}>Optimize</PanelTitle>
      {tips.length === 0 ? (
        <EmptyHint className="mt-2">No tips right now.</EmptyHint>
      ) : (
        <div className="mt-2 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}>
          {tips.map((t) => {
            const st = TIP_STYLE[t.severity];
            return (
              <div key={t.id} className="flex gap-3 rounded-xl border border-line p-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-bold text-white" style={{ background: st.color }} title={st.label}>
                  {st.icon}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{t.title}</span>
                    {t.saving && t.saving > 0.01 && <span className="chip">~{formatUSD(t.saving)}</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-soft">{t.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button className="mt-2 text-xs text-accent hover:underline" onClick={onOpenModels}>Manage models &amp; providers →</button>
    </div>
  );
}

function TokensPanel({ usage }: { usage: UsageSummary | null }) {
  const [range, setRange] = useState<InsightRange>('1m');
  if (!usage) return null;
  const daily = insightDays(usage.daily, range);
  const input = daily.reduce((sum, d) => sum + d.input, 0);
  const output = daily.reduce((sum, d) => sum + d.output, 0);
  const max = Math.max(1, ...daily.map((d) => d.input + d.output));
  return (
    <div className="rounded-xl border border-line p-3.5">
      <PanelTitle>Tokens</PanelTitle>
      <RangeToggles chart="Tokens" range={range} onChange={setRange} />
      <div className="mt-2 flex gap-5 text-xs">
        <div><span className="text-ink-faint">Input</span> <span className="font-semibold tabular-nums">{input.toLocaleString()}</span></div>
        <div><span className="text-ink-faint">Output</span> <span className="font-semibold tabular-nums">{output.toLocaleString()}</span></div>
      </div>
      {daily.length > 0 ? (
        <div className="mt-3 flex h-24 items-end gap-1">
          {daily.map((d) => (
            <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.date}: ${(d.input + d.output).toLocaleString()} tok`}>
              <div className="rounded-t" style={{ height: `${((d.input + d.output) / max) * 100}%`, background: 'var(--accent)', minHeight: 2 }} />
            </div>
          ))}
        </div>
      ) : (
        <ChartEmpty message="No usage recorded in this range." />
      )}
    </div>
  );
}

function ModelsPanel({ usage, hideCost = false }: { usage: UsageSummary | null; hideCost?: boolean }) {
  const entries = Object.entries(usage?.byModel ?? {}).sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  return (
    <div className="rounded-xl border border-line p-3.5">
      <PanelTitle aside="tokens and cost">By model</PanelTitle>
      {entries.length === 0 ? (
        <EmptyHint className="mt-2">No model has answered yet.</EmptyHint>
      ) : (
        <div className="mt-2 space-y-1">
          {entries.map(([model, v]) => {
            const cost = v.cost ?? estimateCostUSD(model, v.input, v.output);
            const costLabel = cost > 0 ? formatUSD(cost) : v.subscription ? 'Included in plan' : formatUSD(0);
            return (
              <div key={model} className="flex justify-between gap-3 text-xs">
                <span className="truncate font-mono text-ink-soft" title={v.subscription ? 'Included in a subscription plan' : undefined}>{model}</span>
                <span className="shrink-0 tabular-nums text-ink-faint">
                  {(v.input + v.output).toLocaleString()} tok
                  {!hideCost && <span className="ml-2 text-ink">{costLabel}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STOP_LABEL: Record<ReplyStop | 'other', string> = {
  complete: 'Finished',
  loop: 'Stopped looping',
  runaway: 'Runaway output',
  other: 'Other',
};

/** How agent replies end and how many tool steps they take. Replies have no tool-step limit; this shows how long real runs go. */
function RepliesPanel({ usage, sessions }: { usage: UsageSummary | null; sessions: SessionSummary[] }) {
  const r = usage?.replies;
  if (!r) return null;
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Chat';
  const stops = (Object.keys(STOP_LABEL) as Array<ReplyStop | 'other'>).filter((k) => r.byStop[k] > 0);
  return (
    <div className="rounded-xl border border-line p-3.5">
      <PanelTitle aside="tool steps per reply">Replies</PanelTitle>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <div><span className="text-ink-faint">Replies</span> <span className="font-semibold tabular-nums">{r.total.toLocaleString()}</span></div>
        <div><span className="text-ink-faint">Median</span> <span className="font-semibold tabular-nums">{r.p50Steps}</span></div>
        <div><span className="text-ink-faint">90th pct</span> <span className="font-semibold tabular-nums">{r.p90Steps}</span></div>
        <div><span className="text-ink-faint">Most</span> <span className="font-semibold tabular-nums">{r.mostSteps}</span></div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {stops.map((k) => (
          <span key={k} className={k === 'complete' ? 'text-ink-faint' : 'text-ink-soft'}>
            {STOP_LABEL[k]} <span className="tabular-nums text-ink">{r.byStop[k]}</span>
          </span>
        ))}
      </div>
      {r.recentStops.length > 0 && (
        <div className="mt-3 space-y-1">
          {r.recentStops.slice(0, 6).map((s) => (
            <div key={`${s.ts}_${s.sessionId}`} className="flex justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-ink-soft">{titleOf(s.sessionId)}</span>
              <span className="shrink-0 tabular-nums text-ink-faint">{STOP_LABEL[s.stop]} · {s.steps} steps · <span className="font-mono">{s.modelId}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A friendly skeleton placeholder for a chart with no data yet. */
function ChartEmpty({ message, bars = 12 }: { message: string; bars?: number }) {
  const heights = Array.from({ length: bars }, (_, i) => 30 + ((i * 37) % 60));
  return (
    <div className="mt-3 rounded-xl border border-dashed border-line p-3">
      <div className="flex h-16 items-end gap-1 opacity-40">
        {heights.map((h, i) => (
          <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: 'var(--ink-faint)' }} />
        ))}
      </div>
      <p className="mt-2 text-center text-xs text-ink-faint">{message}</p>
    </div>
  );
}

/** Cost: monthly actual + projection, the daily chart, the top agents, and the pricing reference. */
function CostPanel({ usage, sessions, providers }: { usage: UsageSummary | null; sessions: SessionSummary[]; providers: ProviderConfig[] }) {
  const [range, setRange] = useState<InsightRange>('1m');
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Chat';
  const benchmark = useStore((s) => s.settings?.localCostBenchmark ?? DEFAULT_LOCAL_COST_BENCHMARK);
  const avoided = usage?.avoidedCosts;
  const hasData = !!usage && (usage.totalInput + usage.totalOutput > 0 || !!usage.hasSubscriptionUsage);
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthDaily = (usage?.daily ?? []).filter((d) => d.date.startsWith(monthKey));
  const monthActual = monthDaily.reduce((s, d) => s + (d.cost ?? 0), 0);
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projected = dayOfMonth > 0 ? (monthActual / dayOfMonth) * daysInMonth : monthActual;
  const topAgents = useMemo(
    () => Object.entries(usage?.bySessionCost ?? {}).filter(([, c]) => c > 0.0000001).sort((a, b) => b[1] - a[1]).slice(0, 5),
    [usage],
  );
  const maxAgent = Math.max(0.0001, ...topAgents.map(([, c]) => c));
  const recentCost = insightDays(usage?.daily ?? [], range);
  const maxDayCost = Math.max(0.0001, ...recentCost.map((d) => d.cost ?? 0));
  const subscriptionChats = useMemo(() => {
    if (!usage?.hasSubscriptionUsage) return [] as SessionSummary[];
    return sessions.filter((s) => {
      const t = usage.bySession[s.id];
      const p = providers.find((p) => p.id === s.providerId);
      return p?.auth === 'subscription' && t && t.input + t.output > 0;
    });
  }, [usage, sessions, providers]);

  return (
    <div className="rounded-xl border border-line p-3.5">
      <PanelTitle aside="est. · list prices · local models are free">Cost</PanelTitle>
      <RangeToggles chart="Cost" range={range} onChange={setRange} />
      {!hasData ? (
        <ChartEmpty message="No spend yet. Once a cloud model answers, this month, the projection and the top agents show here." />
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-faint">
            <Stat value={formatUSD(monthActual)} label={`this month (${dayOfMonth}/${daysInMonth})`} />
            <StatDivider />
            <Stat value={formatUSD(projected)} label="projected" />
            <StatDivider />
            <Stat value={formatUSD(usage!.totalCost ?? 0)} label="all time" />
          </div>
          <div className="mt-2 text-xs text-ink-faint">Selected range <span className="font-semibold tabular-nums text-ink">{formatUSD(recentCost.reduce((sum, d) => sum + (d.cost ?? 0), 0))}</span></div>
          {recentCost.length === 0 && <ChartEmpty message="No usage recorded in this range." />}
          <div className="mt-3 flex h-16 items-end gap-1">
            {recentCost.map((d) => (
              <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.date}: ${formatUSD(d.cost ?? 0)}`}>
                <div className="rounded-t" style={{ height: `${((d.cost ?? 0) / maxDayCost) * 100}%`, background: 'var(--warning)', minHeight: (d.cost ?? 0) > 0 ? 2 : 0 }} />
              </div>
            ))}
          </div>
          {topAgents.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="text-2xs font-medium text-ink-faint">By agent</div>
              {topAgents.map(([sid, cost]) => (
                <div key={sid}>
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-ink-soft">{titleOf(sid)}</span>
                    <span className="shrink-0 tabular-nums text-ink">{formatUSD(cost)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                    <div className="h-full rounded-full" style={{ width: `${(cost / maxAgent) * 100}%`, background: 'var(--accent)' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {subscriptionChats.length > 0 && topAgents.length === 0 && (
            <p className="mt-2 text-xs text-ink-soft">{subscriptionChats.length} chat{subscriptionChats.length === 1 ? '' : 's'} ran on a subscription plan. No API spend to show.</p>
          )}
        </>
      )}
      <div className="mt-3 border-t border-line pt-3 text-xs">
        <div className="font-medium">Estimated API costs avoided · all time</div>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          <Stat value={formatUSD(avoided?.subscription ?? 0)} label="subscription" tone="var(--success)" />
          <Stat value={formatUSD(avoided?.local ?? 0)} label="local AI" tone="var(--success)" />
        </div>
        <label className="mt-3 block text-2xs text-ink-faint">
          Cloud benchmark for unpriced local models
          <select className="input mt-1 w-full" value={benchmark} onChange={(e) => {
            void window.nekko.updateSettings({ localCostBenchmark: e.target.value }).then(() => useStore.getState().refreshSettings());
          }}>
            <option value="">None · show unpriced usage</option>
            {MODEL_PRICING.map((p) => <option key={p.match} value={p.match}>{p.match} · ${p.input} in / ${p.output} out per 1M</option>)}
          </select>
        </label>
        <p className="mt-2 text-2xs text-ink-faint">Cloud list-price equivalents, not net savings. Excludes subscription fees, hardware and electricity. Benchmark changes recalculate local history.</p>
        {!!avoided?.benchmarkTokens && <p className="mt-1 text-2xs text-ink-faint">{avoided.benchmarkTokens.toLocaleString()} local tokens compared with {benchmark}.</p>}
        {!!avoided?.unpricedTokens && <p className="mt-1 text-2xs text-ink-faint">{avoided.unpricedTokens.toLocaleString()} tokens have no cloud price and are excluded.</p>}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink">Token pricing reference (USD per 1M tokens)</summary>
        <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {MODEL_PRICING.map((p) => (
            <div key={p.match} className="flex justify-between gap-2 text-xs">
              <span className="font-mono text-ink-soft">{p.match}</span>
              <span className="tabular-nums text-ink-faint">in ${p.input} · out ${p.output}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-2xs text-ink-faint">Published list prices, matched by model id. Estimates only. Local models and subscription plans have no per-token API charge; plan fees and local operating costs are not tracked.</p>
      </details>
    </div>
  );
}

function ServicesPanel({ providers, usage }: { providers: ProviderConfig[]; usage: UsageSummary | null }) {
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [mcp, setMcp] = useState<import('@nekko-agent/shared').McpServerStatus[]>([]);
  useEffect(() => { window.nekko.getRemoteStatus().then(setRemote).catch(() => setRemote(null)); }, []);
  useEffect(() => { window.nekko.getMcpStatus().then(setMcp).catch(() => setMcp([])); }, []);
  return (
    <div>
      <PanelTitle aside="live status">Services</PanelTitle>
      <div className="mt-2 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' }}>
        <RemoteCard remote={remote} />
        {providers.map((p) => <WorkerCard key={p.id} provider={p} tokens={usage?.byProvider[p.id]} />)}
        {mcp.map((m) => (
          <div key={m.id} className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-base">🔌</span>
                <span className="text-sm font-medium">{m.name}</span>
                <span className="chip">MCP</span>
              </div>
              <StatusPill state={m.connected ? 'online' : 'offline'} />
            </div>
            <p className="mt-2 text-xs text-ink-faint">{m.connected ? `${m.tools.length} tool${m.tools.length === 1 ? '' : 's'} available` : m.error ?? 'Not connected'}</p>
          </div>
        ))}
        {providers.length === 0 && mcp.length === 0 && (
          <div className="rounded-xl border border-line p-3 text-xs text-ink-faint">No model providers yet, add one in Models.</div>
        )}
      </div>
    </div>
  );
}

function WorkerCard({ provider, tokens }: { provider: ProviderConfig; tokens?: { input: number; output: number } }) {
  const [state, setState] = useState<'checking' | 'online' | 'offline'>('checking');
  useEffect(() => {
    window.nekko.testProvider(provider.id).then((r) => setState(r.ok ? 'online' : 'offline')).catch(() => setState('offline'));
  }, [provider.id]);
  const total = tokens ? tokens.input + tokens.output : 0;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ServerIcon className="h-4 w-4 text-ink-faint" />
          <span className="text-sm font-medium">{provider.label}</span>
          <span className="chip">{isLocalProvider(provider.kind) ? 'local' : 'cloud'}</span>
        </div>
        <StatusPill state={state} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
        <span className="truncate font-mono">{provider.baseUrl}</span>
        <span className="shrink-0 tabular-nums">{total.toLocaleString()} tok</span>
      </div>
    </div>
  );
}

function RemoteCard({ remote }: { remote: RemoteStatus | null }) {
  const online = !!remote?.enabled;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">📱</span>
          <span className="text-sm font-medium">Remote relay</span>
        </div>
        <StatusPill state={online ? 'online' : 'offline'} onlineLabel="enabled" offlineLabel="off" />
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        {online ? 'Your phone can reach this machine’s model over an encrypted relay.' : 'Enable in Settings → Remote access to drive your local model from anywhere.'}
      </p>
    </div>
  );
}

function StatusPill({ state, onlineLabel = 'online', offlineLabel = 'offline' }: { state: 'checking' | 'online' | 'offline'; onlineLabel?: string; offlineLabel?: string }) {
  if (state === 'checking') return <span className="chip">checking…</span>;
  const online = state === 'online';
  return (
    <Badge tone={online ? 'success' : 'neutral'} variant="solid">
      {online && <CheckIcon className="h-3 w-3" />} {online ? onlineLabel : offlineLabel}
    </Badge>
  );
}
