import type { Session } from '@nekko-agent/shared';

/** What the Add window picker asked a new chat to be. */
export interface NewAgentChoice {
  chatType?: Session['chatType'];
  providerId?: string;
  modelId?: string;
  /** Working folder first, then supporting folders. */
  workspaceIds?: string[];
}

/**
 * The host calls a just-created chat still needs before its window opens.
 * Each one is a round trip the new window waits on, so a call that would
 * change nothing (a plain chat with no model picked, no supporting folders)
 * is skipped rather than made.
 */
export function newAgentSetup(created: Pick<Session, 'chatType' | 'supportingWorkspaceIds'>, choice: NewAgentChoice): { options: boolean; supporting: boolean } {
  const chatType = choice.chatType ?? 'multimodal';
  const supporting = choice.workspaceIds?.slice(1) ?? [];
  return {
    options: chatType !== (created.chatType ?? 'multimodal') || !!choice.providerId || !!choice.modelId,
    supporting: !!choice.workspaceIds && (supporting.length > 0 || !!created.supportingWorkspaceIds?.length),
  };
}
