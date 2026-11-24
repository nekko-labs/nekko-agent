import { useEffect } from 'react';
import { CLAUDE_CODE_PROVIDER_KIND } from '@nekko-agent/shared';
import type { NekkoApi, ProviderConfig, Session } from '@nekko-agent/shared';
import { useStore } from '../store.js';

/** What runs a chat's turns, as far as code mode cares: Claude Code (never applies), anything else, or not known yet. */
export type ChatEngine = 'claude-agent' | 'other' | 'unknown';

/**
 * Whether the model that will run this chat is Claude Code. `providerId` is the
 * chat's resolved provider (its own pick, the saved default, or the first
 * connected one), not just `session.providerId`, which is empty for a chat that
 * never picked. An id the provider list cannot place yet is `unknown`.
 */
export function chatEngine(providers: Pick<ProviderConfig, 'id' | 'kind'>[] | undefined, providersLoaded: boolean, providerId: string | null | undefined): ChatEngine {
  if (!providerId) return 'other';
  const found = providers?.find((p) => p.id === providerId);
  if (found) return found.kind === CLAUDE_CODE_PROVIDER_KIND ? 'claude-agent' : 'other';
  return providersLoaded ? 'other' : 'unknown';
}

/** The chat's engine, read from the store. */
export function useChatEngine(providerId: string | null | undefined): ChatEngine {
  return useStore((s) => chatEngine(s.providers, s.providersLoaded, providerId));
}

/**
 * Put a Claude Agent chat's code mode back to the tool list, on the chat only:
 * the app-wide default for new chats belongs to the user's other models and
 * stays. Resolves with the chat when it changed.
 */
export async function dropCodeModeOnClaudeAgent(
  api: Pick<NekkoApi, 'setSessionOptions'>,
  session: Pick<Session, 'id' | 'toolApproach'> | null | undefined,
): Promise<Session | null> {
  if (!session || session.toolApproach !== 'code') return null;
  return api.setSessionOptions(session.id, { toolApproach: 'list' }, { chatOnly: true });
}

/** Keeps `dropCodeModeOnClaudeAgent` applied while the chat runs on Claude Code. */
export function useDropCodeModeOnClaudeAgent(engine: ChatEngine, session: Session | null | undefined, onChange: (s: Session) => void, enabled = true) {
  const code = session?.toolApproach === 'code';
  const id = session?.id;
  useEffect(() => {
    if (!enabled || engine !== 'claude-agent' || !code || !id) return;
    let live = true;
    dropCodeModeOnClaudeAgent(window.nekko, { id, toolApproach: 'code' })
      .then((next) => { if (live && next) onChange(next); })
      .catch((e) => useStore.getState().pushToast('error', String(e)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, engine, code, id]);
}
