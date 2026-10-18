import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';
import type { Provider, ChatRequest, ProviderChunk } from './types.js';

/** Claude Code's model aliases (`--model`); a session reports the full id it runs on. */
export const CLAUDE_CODE_MODEL_ALIASES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'opus', name: 'Claude Opus' },
  { id: 'sonnet', name: 'Claude Sonnet' },
  { id: 'haiku', name: 'Claude Haiku' },
];

export const CLAUDE_CODE_NOT_A_MODEL_API = 'Claude Agent chats run in your installed Claude Code, not through a model API.';

/**
 * The Claude Agent provider (`claude-code`), mirroring the Rust one: the
 * user's own Claude Code runs these chats (nekkod drives it), so there is no
 * wire here. It lists the model aliases and refuses a direct chat.
 */
export class ClaudeCodeProvider implements Provider {
  constructor(readonly config: ProviderConfig) {}

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_CODE_MODEL_ALIASES.map((m) => ({ id: m.id, name: m.name, providerId: this.config.id }));
  }

  // eslint-disable-next-line require-yield
  async *chat(_req: ChatRequest): AsyncIterable<ProviderChunk> {
    throw new Error(CLAUDE_CODE_NOT_A_MODEL_API);
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Claude Agent uses your installed Claude Code.' };
  }
}
