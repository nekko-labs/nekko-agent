import type { ContextItem } from '@nekko-agent/shared';
import { CONTEXT_SOURCE, STATUS, SURFACE } from './tokens.js';

/**
 * Label, bar color, and plain-language explanation for each context source.
 * The single source of truth shared by the composer's context gauge and the
 * Context Inspector, so the color vocabulary can never drift between the two.
 * Colors resolve through the semantic provenance tokens (see tokens.ts).
 */
export const SOURCE_META: Record<ContextItem['source'] | 'draft' | 'reply' | 'claude-code', { label: string; color: string; explain: string }> = {
  system: {
    label: 'System prompt',
    color: CONTEXT_SOURCE.system,
    explain: "Nekko Agent's base instructions to the model, its role, available tools, and safety rules. Always included.",
  },
  conversation: {
    label: 'Conversation',
    color: CONTEXT_SOURCE.conversation,
    explain: 'The running back-and-forth of this chat. It grows with every reply, the biggest driver of context as a chat gets long.',
  },
  guideline: {
    label: 'Guidelines',
    color: CONTEXT_SOURCE.guideline,
    explain: 'Your project guideline files (AGENTS.md / CLAUDE.md and similar) that tell the model how to work in this repo.',
  },
  memory: {
    label: 'Memory',
    color: CONTEXT_SOURCE.memory,
    explain: 'Facts Nekko Agent remembers across chats, your preferences and project notes, that match this conversation.',
  },
  'attached-file': {
    label: 'Files',
    color: CONTEXT_SOURCE['attached-file'],
    explain: 'Files you attached to this chat. Included in full on every reply.',
  },
  connector: {
    label: 'Connectors',
    color: CONTEXT_SOURCE.connector,
    explain: 'Content pulled from your connected tools and integrations that is relevant to this prompt.',
  },
  'index-snippet': {
    label: 'Code index',
    color: CONTEXT_SOURCE['index-snippet'],
    explain: "Code snippets retrieved from your workspace index that match this reply's prompt.",
  },
  skill: {
    label: 'Skill',
    color: CONTEXT_SOURCE.skill,
    explain: 'The skill armed in the composer. Its instructions are added to your message when you send.',
  },
  // Renderer-only: the unsent draft never reaches the host's context bundle, but
  // it is what the next reply will cost, so both gauges count it live.
  draft: {
    label: 'Your message',
    color: SURFACE.accent,
    explain: "What you're typing now. It joins the conversation the moment you send, so it already counts against the window.",
  },
  // Renderer-only: the reply in flight. Its text, tool calls, and results are
  // replayed in the next request, so they cost window space before the turn ends.
  reply: {
    label: 'This reply',
    color: STATUS.info,
    explain: 'What the agent is writing right now, plus the tools it is running. All of it is carried into the next step of the same turn.',
  },
  // Renderer-only: a Claude Agent chat's context as Claude Code reported it.
  // Claude Code builds that request itself, so it comes as one total.
  'claude-code': {
    label: 'Claude Code',
    color: CONTEXT_SOURCE.conversation,
    explain: "What Claude Code's last model call sent: its own system prompt and tools, this chat's history and the files it read. It drops when Claude Code compacts the chat.",
  },
};

export function sourceMeta(src: string): { label: string; color: string } {
  return SOURCE_META[src as ContextItem['source']] ?? { label: src, color: STATUS.neutral };
}
