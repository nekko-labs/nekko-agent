import React, { useMemo } from 'react';
import type { WorkflowEdge, WorkflowNode, WorkflowRun, WorkflowStep, WorkflowStepKind, WorkflowStepStatus } from '@nekko-agent/shared';
import { layoutWorkflow, workflowGraph } from '@nekko-agent/shared';
import { STATUS } from '../tokens.js';

/**
 * The step graph of a workflow, drawn as a node canvas in the same visual
 * language as the Skills tab (same layered layout, same bezier edges, dotted
 * grid). Two things are specific to workflows: a failure route is drawn in the
 * danger color beside the success route, and a route back to an earlier step
 * loops under the row as a dashed edge, so "verify sends this back to build" is
 * something you can see rather than something you have to read.
 *
 * When a run is passed, each node wears that run's outcome for the step, so the
 * same picture doubles as the live progress view.
 */

const KIND: Record<WorkflowStepKind | 'terminal', { color: string; glyph: string; label: string }> = {
  prompt: { color: 'var(--cat-conversation)', glyph: '✦', label: 'Prompt' },
  skill: { color: 'var(--cat-skill)', glyph: '◈', label: 'Skill' },
  workflow: { color: 'var(--info)', glyph: '⇥', label: 'Workflow' },
  shell: { color: 'var(--cat-index)', glyph: '$', label: 'Shell' },
  action: { color: 'var(--accent)', glyph: '↗', label: 'Action' },
  terminal: { color: 'var(--neutral)', glyph: '●', label: 'End' },
};

const STEP_TONE: Record<WorkflowStepStatus, string> = {
  pending: STATUS.neutral,
  running: STATUS.running,
  success: STATUS.success,
  failure: STATUS.danger,
  skipped: STATUS.neutral,
};

/** The latest recorded attempt per step in a run, which is the state to show. */
function latestByStep(run?: WorkflowRun): Map<string, { status: WorkflowStepStatus; attempt: number }> {
  const out = new Map<string, { status: WorkflowStepStatus; attempt: number }>();
  for (const s of run?.steps ?? []) out.set(s.stepId, { status: s.status, attempt: s.attempt });
  return out;
}

export function WorkflowCanvas({
  steps,
  run,
  selectedId,
  onSelect,
  modelLabel,
}: {
  steps: WorkflowStep[];
  run?: WorkflowRun;
  selectedId?: string | null;
  onSelect?: (stepId: string) => void;
  /** The model a step overrides the workflow's with, as a short label, or undefined. */
  modelLabel?: (step: WorkflowStep) => string | undefined;
}) {
  const graph = useMemo(() => workflowGraph(steps), [steps]);
  const layout = useMemo(() => layoutWorkflow<WorkflowNode, WorkflowEdge>(graph, { nodeW: 168, nodeH: 62 }), [graph]);
  const { nodes, edges, width, height, nodeW, nodeH } = layout;
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const state = useMemo(() => latestByStep(run), [run]);

  if (steps.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-ink-faint">
        No steps yet. Add one and it appears here.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div
        className="relative"
        style={{
          width,
          height,
          minWidth: width,
          backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
        }}
      >
        <svg width={width} height={height} className="absolute inset-0" style={{ overflow: 'visible' }}>
          <defs>
            <marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-faint)" />
            </marker>
            <marker id="wf-arrow-fail" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={STATUS.danger} />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const failure = e.kind === 'failure';
            // Failure edges ride slightly below the success edge between the same
            // pair, so a step with both routes doesn't draw them on top of each other.
            const { d, lx, ly } = edgePath(a, b, nodeW, nodeH, e.back, failure ? 12 : 0);
            return (
              <g key={`${e.from}-${e.to}-${e.kind}-${i}`}>
                <path
                  d={d}
                  fill="none"
                  stroke={failure ? STATUS.danger : 'var(--ink-faint)'}
                  strokeWidth={1.5}
                  strokeDasharray={e.back ? '4 4' : undefined}
                  markerEnd={failure ? 'url(#wf-arrow-fail)' : 'url(#wf-arrow)'}
                  opacity={failure ? 0.75 : 0.9}
                />
                <text x={lx} y={ly} textAnchor="middle" className="select-none" style={{ fontSize: 9.5, fill: failure ? STATUS.danger : 'var(--ink-soft)' }}>
                  <tspan dy="-2">{e.back ? (failure ? 'on failure, retry' : 'loops back') : failure ? 'on failure' : ''}</tspan>
                </text>
              </g>
            );
          })}
        </svg>

        {nodes.map((n) => {
          const kind = KIND[n.kind];
          const outcome = state.get(n.id);
          const tone = outcome ? STEP_TONE[outcome.status] : undefined;
          const isStep = n.kind !== 'terminal';
          return (
            <button
              key={n.id}
              className="card absolute flex flex-col justify-center overflow-hidden px-3 py-2 text-left transition"
              style={{
                left: n.x,
                top: n.y,
                width: nodeW,
                height: nodeH,
                borderLeft: `3px solid ${tone ?? kind.color}`,
                cursor: isStep && onSelect ? 'pointer' : 'default',
                boxShadow: selectedId === n.id ? `0 0 0 2px ${kind.color}` : undefined,
                opacity: n.kind === 'terminal' ? 0.75 : 1,
              }}
              title={n.detail}
              onClick={() => isStep && onSelect?.(n.id)}
            >
              <div className="flex items-center gap-2">
                <span style={{ color: kind.color }}>{kind.glyph}</span>
                <span className="truncate text-xs font-medium leading-tight">{n.label}</span>
                {n.step && modelLabel?.(n.step) ? (
                  <span
                    className="ml-auto min-w-0 max-w-[60%] shrink truncate rounded-sm px-1 text-2xs text-ink-soft"
                    style={{ background: 'var(--surface-2)' }}
                    data-step-model
                    title={`Model: ${modelLabel(n.step)}`}
                  >
                    {modelLabel(n.step)}
                  </span>
                ) : null}
                {outcome?.status === 'running' && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: STATUS.running }} />
                )}
                {outcome && outcome.attempt > 1 && (
                  <span className="ml-auto shrink-0 font-mono text-2xs text-ink-faint">×{outcome.attempt}</span>
                )}
              </div>
              {n.detail && <p className="mt-0.5 truncate text-2xs text-ink-faint">{n.detail}</p>}
              {n.step?.retries ? (
                <p className="truncate font-mono text-2xs text-ink-faint">retries {n.step.retries}</p>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Bezier between two node boxes. Forward edges leave the right face and enter
 * the left; a back edge dips under the row and re-enters the target's bottom.
 * `drop` nudges a second edge between the same pair clear of the first.
 */
function edgePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  w: number,
  h: number,
  back?: boolean,
  drop = 0,
) {
  if (back) {
    const sx = a.x + w / 2;
    const sy = a.y + h;
    const tx = b.x + w / 2;
    const ty = b.y + h;
    const dip = Math.max(sy, ty) + 46 + drop;
    return { d: `M ${sx} ${sy} C ${sx} ${dip}, ${tx} ${dip}, ${tx} ${ty}`, lx: (sx + tx) / 2, ly: dip - 6 };
  }
  const sx = a.x + w;
  const sy = a.y + h / 2 + drop;
  const tx = b.x;
  const ty = b.y + h / 2 + drop;
  const dx = Math.max(28, (tx - sx) / 2);
  return {
    d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
    lx: (sx + tx) / 2,
    ly: (sy + ty) / 2 - 4,
  };
}

export { KIND as STEP_KIND_STYLE };
