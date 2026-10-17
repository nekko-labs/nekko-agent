import type { ToolCall } from '@nekko-agent/shared';

export interface PaneApproval { call: ToolCall; reason: string }

/** A result settles its own approval, not an unrelated concurrent request. */
export function approvalAfterResult<T extends PaneApproval>(current: T | null, toolCallId: string): T | null {
  return current?.call.id === toolCallId ? null : current;
}
