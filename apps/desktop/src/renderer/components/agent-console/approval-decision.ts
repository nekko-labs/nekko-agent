import type { NekkoApi } from '@nekko-agent/shared';

/**
 * How far an approval reaches: this call only, this MCP tool in this chat
 * (`tool`), every call in this chat (`session`, YOLO), or every chat
 * (`always`, YOLO as the default too).
 */
export type ApprovalScope = 'once' | 'tool' | 'session' | 'always';

/** Only MCP tools offer "Always allow this tool": their server alone says what they do. */
export function offersToolScope(toolName: string): boolean {
  return toolName.startsWith('mcp__');
}

/** Save the policy before releasing the pending tool, so the next call sees it. */
export async function decideApproval(
  api: Pick<NekkoApi, 'setSessionOptions' | 'updateSettings' | 'approveTool'>,
  sessionId: string,
  callId: string,
  approved: boolean,
  scope: ApprovalScope = 'once',
  tool?: { name: string; allowed?: readonly string[] },
) {
  if (approved && scope === 'tool') {
    if (!tool || !offersToolScope(tool.name)) throw new Error('Only an MCP tool can be always allowed.');
    const allowedMcpTools = [...new Set([...(tool.allowed ?? []), tool.name])];
    const session = await api.setSessionOptions(sessionId, { allowedMcpTools });
    if (!session) throw new Error('Could not save the allowed tool for this chat.');
    await api.approveTool(sessionId, callId, true);
    return { session, settings: null };
  }
  const session = approved && scope !== 'once'
    ? await api.setSessionOptions(sessionId, { mode: 'yolo' })
    : null;
  if (approved && scope !== 'once' && !session) throw new Error('Could not update this session’s approval mode.');
  const settings = approved && scope === 'always'
    ? await api.updateSettings({ defaultChatMode: 'yolo' })
    : null;
  await api.approveTool(sessionId, callId, approved);
  return { session, settings };
}
