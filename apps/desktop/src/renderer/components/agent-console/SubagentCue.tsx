import { createContext, useContext } from 'react';
import { BranchIcon, RobotIcon } from '../../icons.js';
import type { SessionSummary, ToolCall, ToolResult } from '@nekko-agent/shared';
import { getLiveRun, useLiveRunsVersion } from '../../liveRuns.js';
import { activitySentence, compactSentence, delegationActivity, delegationChild } from '../../subagentActivity.js';

export const SubagentParentContext = createContext<SessionSummary[]>([]);
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
export function subagentTitle(call: ToolCall): string {
  return typeof call.input.title === 'string' && call.input.title.trim() ? compactSentence(call.input.title) : 'Subagent';
}

/** A fork and agent together distinguish delegation from ordinary tool work. */
export function SubagentCue() {
  return <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-accent"><BranchIcon className="h-3.5 w-3.5" /><RobotIcon className="h-3.5 w-3.5" /></span>;
}
