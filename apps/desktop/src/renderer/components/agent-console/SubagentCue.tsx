import { createContext, useContext } from 'react';
import { BranchIcon, RobotIcon } from '../../icons.js';
import { useStore } from '../../store.js';
import type { SessionSummary, ToolCall, ToolResult } from '@nekko-agent/shared';
import { getLiveRun, useLiveRunsVersion } from '../../liveRuns.js';
import { activitySentence, compactSentence, delegationActivity, delegationChild } from '../../subagentActivity.js';

export const SubagentParentContext = createContext<SessionSummary[]>([]);
/**
 * The model a child gets when the call names none: the saved delegation route,
 * else the parent chat's own model.
 */
export const SubagentInheritedModelContext = createContext<string | undefined>(undefined);

export function subagentSummary(call: ToolCall): string {
  return activitySentence(delegationActivity(call));
}
export function useSubagentSummary(call: ToolCall, result?: ToolResult): string {
  useLiveRunsVersion();
  const children = useContext(SubagentParentContext);
  const child = delegationChild(call, children);
  return activitySentence(delegationActivity(call, child, result, !!child && !!getLiveRun(child.id)));
}
export function SubagentHeadline({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const summary = useSubagentSummary(call, result);
  return <span className="min-w-0 truncate" title={summary}>{summary}</span>;
}
/** A sibling of the details toggle, never an interactive element inside it. */
export function SubagentOpenButton({ call }: { call: ToolCall }) {
  const children = useContext(SubagentParentContext);
  const child = delegationChild(call, children);
  if (!child) return null;
  return <button type="button" className="shrink-0 rounded px-1.5 text-[11px] text-accent hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-(--ring)" aria-label={`Open subagent: ${child.title}`} title={`Open ${child.title}`} onClick={() => {
    const store = useStore.getState();
    store.openChatPane(child.id);
  }}>Open ↗</button>;
}

export function subagentTitle(call: ToolCall): string {
  return typeof call.input.title === 'string' && call.input.title.trim() ? compactSentence(call.input.title) : 'Subagent';
}

/** `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`; `org/model:latest` → `model`. */
export function shortModelName(id: string): string {
  const tail = id.split('/').filter(Boolean).pop() ?? id;
  return tail.replace(/:latest$/i, '').replace(/-\d{8}$/, '');
}

export type SubagentModelSource = 'child' | 'requested' | 'inherited';
/**
 * Which model a delegation ran on. A matched child chat is the truth. Failing
 * that the call's own `model_id`, then what an unrouted call inherits.
 */
export function subagentModel(call: ToolCall, child: SessionSummary | undefined, children: SessionSummary[], inherited?: string): { id: string; source: SubagentModelSource } | undefined {
  if (child?.modelId) return { id: child.modelId, source: 'child' };
  // Persisted rows are not matched live; a uniquely titled child is still this call's.
  const title = typeof call.input.title === 'string' && call.input.title.trim() ? call.input.title.trim() : typeof call.input.task === 'string' ? call.input.task.trim().slice(0, 40) : '';
  const named = title ? children.filter((c) => c.title === title) : [];
  if (named.length === 1 && named[0].modelId) return { id: named[0].modelId, source: 'child' };
  if (typeof call.input.model_id === 'string' && call.input.model_id.trim()) return { id: call.input.model_id.trim(), source: 'requested' };
  if (!('provider_id' in call.input) && inherited) return { id: inherited, source: 'inherited' };
  return undefined;
}

export function useSubagentModel(call: ToolCall) {
  const children = useContext(SubagentParentContext);
  const inherited = useContext(SubagentInheritedModelContext);
  return subagentModel(call, delegationChild(call, children), children, inherited);
}

/** The child's model, as a quiet chip beside its status. */
export function SubagentModelChip({ call }: { call: ToolCall }) {
  const model = useSubagentModel(call);
  if (!model) return null;
  const why = model.source === 'child' ? 'from the child chat' : model.source === 'requested' ? 'requested by the delegation call' : 'inherited from this chat';
  return (
    <span className="max-w-[40%] shrink-0 truncate rounded border border-line px-1.5 py-0.5 text-[10px] font-normal text-ink-faint" title={`Model: ${model.id} (${why})`} data-subagent-model>
      {shortModelName(model.id)}
    </span>
  );
}

/** A fork and agent together distinguish delegation from ordinary tool work. */
export function SubagentCue() {
  return <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-accent"><BranchIcon className="h-3.5 w-3.5" /><RobotIcon className="h-3.5 w-3.5" /></span>;
}
