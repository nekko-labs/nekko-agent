import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactKind, ExperimentNode, MazeNode, ModelInfo, ProviderConfig, TrainingRun } from '@nekko-agent/shared';
import { formatRuntime, layoutMaze, runOutputDir, runStats, isLocalProvider, formatModelPriceLabel, modelPricing } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { LogSurface, StatTile } from './primitives/index.js';
import { STATUS } from '../tokens.js';

/**
 * Shared building blocks for the Training dashboard (and the goal runs listed
 * alongside it, which used to have a tab of their own): the stats
 * header tiles, the experiment "idea maze" (every idea the agent tried, growing
 * over time), the guidance composer, the activity log, and the run model
 * picker used by both new-run forms. Mostly pure presentation; all dashboard
 * data flows in as a TrainingRun.
 */

const STATUS_COLOR: Record<TrainingRun['status'], string> = {
  draft: 'var(--ink-faint)',
  running: STATUS.running,
  paused: STATUS.warning,
  completed: STATUS.success,
  stopped: STATUS.neutral,
  failed: STATUS.danger,
};

export function RunStatusChip({ run }: { run: TrainingRun }) {
  const color = STATUS_COLOR[run.status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-2xs uppercase tracking-wider"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${run.status === 'running' ? 'animate-pulse' : ''}`} style={{ background: color }} />
      {run.status}
    </span>
  );
}

function fmtScore(v?: number): string {
  if (v == null) return '—';
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** The dashboard's stat tiles (best score, experiments, success rate, …). */
export function RunStatTiles({ run }: { run: TrainingRun }) {
  const s = runStats(run);
  const best = run.experiments.find((e) => e.id === run.bestExperimentId);
  const tiles: Array<{ label: string; value: string; color?: string; sub?: string }> = [
    { label: `Best ${s.bestMetric ?? 'score'}`, value: fmtScore(s.best), color: 'var(--accent-2)', sub: best?.title.slice(0, 26) },
    { label: 'Experiments', value: String(s.experiments) },
    { label: 'Success rate', value: s.successRate != null ? `${Math.round(s.successRate * 100)}%` : '—' },
    { label: 'Emergent niches', value: String(s.niches) },
    { label: 'Self-repairs', value: String(s.repairs) },
    { label: 'Runtime', value: formatRuntime(s.runtimeMs) },
    { label: 'Iterations', value: String(s.turns) },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {tiles.map((t) => (
        <StatTile key={t.label} label={t.label} value={t.value} sub={t.sub} color={t.color} />
      ))}
    </div>
  );
}

/** The champion card: the current leader + the agent's note about it. */
export function ChampionCard({ run }: { run: TrainingRun }) {
  const best = run.experiments.find((e) => e.id === run.bestExperimentId);
  if (!best) return null;
  return (
    <div className="card px-3.5 py-3" style={{ borderColor: 'color-mix(in srgb, var(--success) 35%, var(--line))' }}>
      <div className="font-mono text-2xs uppercase tracking-[0.14em]" style={{ color: STATUS.success }}>
        Current champion{best.approach ? ` · ${best.approach}` : ''}
      </div>
      <div className="mt-1 font-mono text-xs font-semibold" style={{ color: STATUS.success }}>{best.title}</div>
      {best.note && <div className="mt-1 text-xs leading-snug text-(--ink-soft)">{best.note}</div>}
    </div>
  );
}

const ARTIFACT_META: Record<ArtifactKind, { icon: string; label: string }> = {
  model: { icon: '🧠', label: 'Model' },
  'agents-md': { icon: '📄', label: 'Agent file' },
  skill: { icon: '🧩', label: 'Skill' },
  spec: { icon: '📐', label: 'Spec' },
  dataset: { icon: '🗂️', label: 'Dataset' },
  code: { icon: '💻', label: 'Code' },
  report: { icon: '📊', label: 'Report' },
  other: { icon: '📦', label: 'Artifact' },
};

function isAbsolutePath(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
}

/** Resolve an artifact path (relative to the workspace, or already absolute). */
function joinPath(base: string | undefined, rel: string): string {
  if (!base || isAbsolutePath(rel)) return rel;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`;
}

/**
 * The Artifacts card: exactly what the run produced (the trained model + its
 * harness files), where each lives, and how to use it. Every path opens in the
 * OS file manager, and the run's output folder is one click away, so a finished
 * run answers "what did I get, and where is it?" at a glance.
 */
export function ArtifactsCard({ run }: { run: TrainingRun }) {
  const { settings } = useStore(useShallow((s) => ({ settings: s.settings })));
  const wsPath = settings?.workspaces?.find((w) => w.id === run.workspaceId)?.path ?? settings?.workspaces?.[0]?.path;
  const outDir = runOutputDir(run);
  const artifacts = run.artifacts ?? [];
  const open = (rel: string) => void window.nekko.openPath(joinPath(wsPath, rel));
  return (
    <div className="card px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-2xs uppercase tracking-[0.14em] text-(--ink-faint)">
          Artifacts{artifacts.length ? ` · ${artifacts.length}` : ''}
        </div>
        <button
          className="font-mono text-2xs text-(--accent) hover:underline"
          onClick={() => open(outDir)}
          title={joinPath(wsPath, outDir)}
        >
          Open output folder →
        </button>
      </div>
      {artifacts.length === 0 ? (
        <p className="mt-2 text-xs leading-snug text-(--ink-faint)">
          Nothing yet. As the agent produces the model and its harness files, each one lands here, saved under{' '}
          <span className="font-mono text-(--ink-soft)">{outDir}</span>.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {artifacts.map((a) => {
            const m = ARTIFACT_META[a.kind] ?? ARTIFACT_META.other;
            return (
              <li key={a.id} className="flex items-start gap-2">
                <span className="mt-px text-sm leading-5" title={m.label}>{m.icon}</span>
                <div className="min-w-0 flex-1">
                  <button
                    className="block max-w-full truncate text-left text-xs font-medium hover:text-(--accent)"
                    onClick={() => open(a.path)}
                    title={`Open ${joinPath(wsPath, a.path)}`}
                  >
                    {a.title}
                  </button>
                  <div className="truncate font-mono text-2xs text-(--ink-faint)">{a.path}</div>
                  {a.note && <div className="mt-0.5 text-2xs leading-snug text-(--ink-soft)">{a.note}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * A live "what's happening right now" strip, shown while a run is in flight so
 * the page always answers "what is it doing?". Calls out the very start
 * explicitly (the empty-dashboard moment right after you hit start), then the
 * currently-running experiment and the latest activity line.
 */
export function RunNowStrip({ run }: { run: TrainingRun }) {
  if (run.status !== 'running') return null;
  const lastLog = [...run.log].reverse().find((l) => l.kind !== 'hint');
  const activeExp = run.experiments.find((e) => e.status === 'running');
  const starting = (run.turns ?? 0) === 0 && run.experiments.length === 0;
  const headline = starting
    ? 'Starting up… the agent is spinning up its first experiment'
    : activeExp
      ? `Running: ${activeExp.title}`
      : 'Working…';
  return (
    <div className="card flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderColor: 'color-mix(in srgb, var(--running) 35%, var(--line))' }}>
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: STATUS.running }} />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: STATUS.running }} />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold" style={{ color: STATUS.running }}>{headline}</div>
        {lastLog && <div className="truncate text-2xs text-(--ink-soft)">{lastLog.text}</div>}
      </div>
    </div>
  );
}

function nodeColor(exp: ExperimentNode, run: TrainingRun, parentScore?: number): { fill: string; ring?: string } {
  if (exp.id === run.bestExperimentId) return { fill: STATUS.highlight, ring: 'color-mix(in srgb, var(--highlight) 35%, transparent)' };
  if (exp.status === 'running') return { fill: STATUS.running, ring: 'color-mix(in srgb, var(--running) 35%, transparent)' };
  if (exp.status === 'failed') return { fill: 'color-mix(in srgb, var(--danger) 55%, transparent)' };
  const improved =
    exp.score != null && parentScore != null && (run.config?.minimizeMetric ? exp.score < parentScore : exp.score > parentScore);
  if (improved || (exp.score != null && parentScore == null && exp.status !== 'planned')) return { fill: STATUS.success };
  return { fill: 'color-mix(in srgb, var(--ink-faint) 65%, transparent)' };
}

/**
 * The idea maze: every experiment the agent tried, laid out chronologically
 * left→right with branches hanging beneath their parents; the path to the
 * current leader is highlighted. Click a node for details.
 */
export function IdeaMaze({ run }: { run: TrainingRun }) {
  const [selected, setSelected] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nodes = useMemo(() => layoutMaze(run), [run]);
  const byId = useMemo(() => new Map(run.experiments.map((e) => [e.id, e])), [run.experiments]);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.exp.id, n])), [nodes]);

  const COL_W = 34;
  const ROW_H = 46;
  const LABEL_H = 128;
  const X0 = 26;
  const maxRow = nodes.reduce((m, n) => Math.max(m, n.row), 0);
  const width = X0 * 2 + Math.max(1, nodes.length) * COL_W;
  const height = LABEL_H + (maxRow + 1) * ROW_H + 26;
  const x = (n: MazeNode) => X0 + n.col * COL_W;
  const y = (n: MazeNode) => LABEL_H + n.row * ROW_H;

  const sel = selected ? byId.get(selected) : null;
  const lastLog = [...run.log].reverse().find((l) => l.kind !== 'hint');

  if (nodes.length === 0) {
    return (
      <div className="card flex h-40 items-center justify-center text-xs text-(--ink-faint)">
        No experiments yet — they appear here live as the agent tries ideas.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--line) px-3.5 py-2">
        <span className="font-mono text-2xs uppercase tracking-[0.16em] text-(--ink-faint)">
          The idea maze — every idea the agent tried, growing over time
        </span>
        <span className="ml-auto flex items-center gap-3 font-mono text-2xs text-(--ink-faint)">
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: 'color-mix(in srgb, var(--ink-faint) 65%, transparent)' }} />tried</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-green-400 align-middle" />got better</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400 align-middle" />best so far</span>
          <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-400 align-middle" />running</span>
          <span><i className="mr-1 inline-block h-0.5 w-4 bg-amber-400/70 align-middle" />path to the leader</span>
        </span>
      </div>
      {lastLog && (
        <div className="border-b border-(--line) px-3.5 py-1.5 font-mono text-2xs text-(--ink-soft)">
          {lastLog.text}
        </div>
      )}
      <div ref={scrollRef} className="overflow-x-auto">
        <svg width={width} height={height} className="block">
          {/* connectors */}
          {nodes.map((n) => {
            if (!n.exp.parentId) return null;
            const p = pos.get(n.exp.parentId);
            if (!p) return null;
            const onPath = n.onBestPath && p.onBestPath;
            return (
              <path
                key={`e-${n.exp.id}`}
                d={`M ${x(p)} ${y(p)} C ${x(p)} ${y(p) + 20}, ${x(n)} ${y(n) - 20}, ${x(n)} ${y(n)}`}
                stroke={onPath ? 'rgba(251,191,36,0.7)' : 'color-mix(in srgb, var(--ink-faint) 35%, transparent)'}
                strokeWidth={onPath ? 2 : 1.2}
                fill="none"
              />
            );
          })}
          {/* spine between consecutive roots (chronology) */}
          {nodes
            .filter((n) => n.row === 0)
            .map((n, i, roots) => {
              if (i === 0) return null;
              const prev = roots[i - 1];
              const onPath = n.onBestPath && prev.onBestPath;
              return (
                <line
                  key={`s-${n.exp.id}`}
                  x1={x(prev)} y1={y(prev)} x2={x(n)} y2={y(n)}
                  stroke={onPath ? 'rgba(251,191,36,0.7)' : 'color-mix(in srgb, var(--ink-faint) 25%, transparent)'}
                  strokeWidth={onPath ? 2 : 1}
                />
              );
            })}
          {/* vertical title labels + nodes */}
          {nodes.map((n) => {
            const parent = n.exp.parentId ? byId.get(n.exp.parentId) : undefined;
            const { fill, ring } = nodeColor(n.exp, run, parent?.score);
            const isSel = selected === n.exp.id;
            return (
              <g key={n.exp.id} className="cursor-pointer" onClick={() => setSelected(isSel ? null : n.exp.id)}>
                {n.row === 0 && (
                  <text
                    x={x(n)} y={y(n) - 14}
                    transform={`rotate(-90 ${x(n)} ${y(n) - 14})`}
                    className="select-none"
                    fontFamily="var(--font-mono, monospace)"
                    fontSize="9"
                    fill={n.exp.id === run.bestExperimentId ? STATUS.highlight : 'var(--ink-faint)'}
                  >
                    {n.exp.title.slice(0, 26)}
                  </text>
                )}
                {ring && <circle cx={x(n)} cy={y(n)} r={11} fill={ring} className={n.exp.status === 'running' ? 'animate-pulse' : ''} />}
                <circle cx={x(n)} cy={y(n)} r={7} fill={fill} stroke={isSel ? 'var(--accent)' : 'rgba(0,0,0,0.25)'} strokeWidth={isSel ? 2 : 1} />
                {n.exp.score != null && (
                  <text x={x(n)} y={y(n) + 20} textAnchor="middle" fontFamily="var(--font-mono, monospace)" fontSize="8.5" fill="var(--ink-faint)">
                    {fmtScore(n.exp.score).slice(0, 6)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {sel && (
        <div className="border-t border-(--line) px-3.5 py-2.5 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <b className="font-mono">{sel.title}</b>
            <span className="font-mono text-2xs uppercase text-(--ink-faint)">{sel.status}</span>
            {sel.score != null && <span className="font-mono text-cyan-400">{fmtScore(sel.score)}{sel.metric ? ` ${sel.metric}` : ''}</span>}
            {sel.approach && <span className="text-(--ink-faint)">family: {sel.approach}</span>}
            {sel.parentId && <span className="text-(--ink-faint)">branched from {sel.parentId}</span>}
          </div>
          {sel.note && <div className="mt-1 text-(--ink-soft)">{sel.note}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * Guidance composer: fold a course-correction into the run's next iteration. Not a
 * chat, one steer at a time, queued as a pending hint and consumed on the next
 * iteration. `title`/`helper`/`buttonLabel` let a surface frame it its own way
 * (a goal run frames it as "Steer the mission").
 */
export function HintComposer({
  run,
  placeholder,
  title = 'Guide the agent',
  helper = "Folded into the agent's next iteration: new approaches to try, course corrections, or pointers to new data.",
  buttonLabel = 'Send',
}: {
  run: TrainingRun;
  placeholder: string;
  title?: string;
  helper?: string;
  buttonLabel?: string;
}) {
  const [text, setText] = useState('');
  const pending = run.hints.filter((h) => !h.consumedAt);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await window.nekko.addTrainingHint(run.id, t);
  };
  return (
    <div className="card px-3.5 py-3">
      <div className="font-mono text-2xs uppercase tracking-[0.14em] text-(--ink-faint)">{title}</div>
      <div className="mt-2 flex gap-2">
        <textarea
          className="input min-h-[44px] flex-1 resize-y py-2 text-xs"
          rows={2}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary self-end" onClick={() => void send()} disabled={!text.trim()}>
          {buttonLabel}
        </button>
      </div>
      {pending.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {pending.map((h) => (
            <span key={h.id} className="rounded-full border border-amber-400/40 px-2 py-0.5 text-2xs text-amber-300" title="Will be folded into the agent's next iteration">
              ⏳ {h.text.slice(0, 60)}
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 text-2xs text-(--ink-faint)">{helper}</div>
    </div>
  );
}

const LOG_KIND_COLOR = {
  info: 'var(--ink-faint)',
  milestone: STATUS.success,
  hint: STATUS.warning,
  error: STATUS.danger,
} as const;

/**
 * Activity feed: milestones, failures, hints, and info as the run progresses.
 *
 * A long run streams thousands of lines, so the feed is a windowed
 * `LogSurface` — oldest first, newest at the bottom, following the tail while
 * the reader is parked there — rather than a growing pile of DOM nodes.
 */
export function RunLog({ run, max = 5000 }: { run: TrainingRun; max?: number }) {
  const entries = run.log.length > max ? run.log.slice(-max) : run.log;
  if (!entries.length) return null;
  return (
    <div className="card px-3.5 py-2.5">
      <div className="font-mono text-2xs uppercase tracking-[0.14em] text-(--ink-faint)">Activity</div>
      <LogSurface
        items={entries}
        label="Run activity log"
        rowHeight={20}
        className="mt-1.5 max-h-64"
        keyOf={(l, i) => `${l.at}-${i}`}
        renderRow={(l) => (
          <div className="flex w-full min-w-0 gap-2 text-xs">
            <span className="shrink-0 font-mono text-2xs tabular-nums text-(--ink-faint)">
              {new Date(l.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ color: LOG_KIND_COLOR[l.kind] }} title={l.text}>{l.text}</span>
          </div>
        )}
      />
    </div>
  );
}

/**
 * Optional agent-model override for a new run: which provider + model drive the
 * run's dedicated agent session. Left on "App default", the run uses the
 * global default model. Picking a provider loads its live model list (with a
 * free-text fallback when the provider can't list models). Both fields must be
 * chosen for the override to apply; the forms only send a complete pair.
 */
export function RunModelPicker({
  providerId, modelId, onChange,
}: {
  providerId: string;
  modelId: string;
  onChange: (next: { providerId: string; modelId: string }) => void;
}) {
  const { settings } = useStore(useShallow((s) => ({ settings: s.settings })));
  const providers = (settings?.providers ?? []).filter((p) => p.enabled) as ProviderConfig[];
  const provider = providers.find((p) => p.id === providerId);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!providerId) { setModels([]); return; }
    let alive = true;
    setLoading(true);
    window.nekko.listModels(providerId)
      .then((ms) => { if (alive) setModels(ms); })
      .catch(() => { if (alive) setModels([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [providerId]);

  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      <select
        className="input w-full"
        value={providerId}
        onChange={(e) => onChange({ providerId: e.target.value, modelId: '' })}
      >
        <option value="">App default</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {!providerId ? (
        <input className="input w-full" disabled placeholder="(uses the default model)" />
      ) : models.length > 0 ? (
        <select
          className="input w-full"
          value={modelId}
          onChange={(e) => onChange({ providerId, modelId: e.target.value })}
        >
          <option value="">Pick a model…</option>
          {models.map((m) => {
            const price = provider
              ? formatModelPriceLabel({ modelId: m.id, auth: provider.auth, isLocal: isLocalProvider(provider.kind), pricing: modelPricing(m) })
              : undefined;
            return (
              <option key={m.id} value={m.id}>
                {m.name || m.id}{price ? ` · ${price}` : ''}
              </option>
            );
          })}
        </select>
      ) : (
        <input
          className="input w-full"
          placeholder={loading ? 'Loading models…' : 'model id, e.g. qwen3:14b'}
          value={modelId}
          onChange={(e) => onChange({ providerId, modelId: e.target.value })}
        />
      )}
    </div>
  );
}
