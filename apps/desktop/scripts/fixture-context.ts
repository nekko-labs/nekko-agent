import { estimateTokens, historyText } from '@nekko-agent/shared';
import type { ContextBundle, ContextItem, HistoryMessage, MemoryEntry } from '@nekko-agent/shared';

export type { HistoryMessage };

/** Inputs the assembler uses to build the context bundle for a turn. */
export interface AssembleInput {
  /** Files explicitly attached by the user (path → content). */
  attached: Array<{ path: string; content: string }>;
  /** Guideline files discovered in the workspace (AGENTS.md / CLAUDE.md / .cursorrules). */
  guidelines: Array<{ path: string; content: string }>;
  /** Relevant memory entries. */
  memory: MemoryEntry[];
  /** Connector-derived snippets. */
  connectorSnippets: Array<{ label: string; origin: string; body: string }>;
  /** Index search snippets relevant to the query. */
  indexSnippets: Array<{ relPath: string; path: string; body: string }>;
  /** The running conversation (so its token weight is reflected in the window). */
  history?: HistoryMessage[];
  /** The base system prompt (framework instructions, tools, safety). */
  systemText?: string;
  contextWindow?: number;
  /** Item ids the user toggled off. */
  excluded?: Set<string>;
  /** Item ids the user pinned. */
  pinned?: Set<string>;
}

const GUIDELINE_NAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', 'GEMINI.md'];

export function isGuidelineFile(name: string): boolean {
  return GUIDELINE_NAMES.includes(name);
}

function preview(text: string, n = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

/**
 * Build a ContextBundle with one provenance record per included item. This is
 * the single source of truth behind the Context Inspector, nothing enters the
 * prompt that isn't represented here.
 */
export function assembleContext(input: AssembleInput): ContextBundle {
  const excluded = input.excluded ?? new Set<string>();
  const pinned = input.pinned ?? new Set<string>();
  const items: ContextItem[] = [];
  /**
   * The full text behind each item, keyed by item id.
   *
   * `preview` is a 160-character display string and nothing more. It was also
   * being handed to `renderContextBlock` as if it were the content, which meant
   * every guideline, attached file and memory entered the prompt truncated to
   * 160 characters while the token count beside it described the whole file. So
   * the model never actually received the files the user attached, and the
   * inspector's total disagreed with the prompt that was really sent. Carrying
   * the content here keeps the two in step by construction: whoever renders the
   * block gets exactly what was counted.
   */
  const contents = new Map<string, string>();

  const push = (
    source: ContextItem['source'],
    id: string,
    label: string,
    origin: string,
    content: string,
  ) => {
    const included = !excluded.has(id);
    contents.set(id, content);
    items.push({
      id,
      source,
      label,
      origin,
      tokens: estimateTokens(content),
      pinned: pinned.has(id),
      included,
      preview: preview(content),
    });
  };

  // The base system prompt and the running conversation always occupy the
  // window; surface them so the Context Inspector total tracks real usage
  // (and grows as the chat gets longer) instead of only counting sources.
  if (input.systemText) {
    items.push({
      id: 'system:base',
      source: 'system',
      label: 'System prompt',
      origin: 'Nekko Agent',
      tokens: estimateTokens(input.systemText),
      pinned: false,
      included: true,
      preview: preview(input.systemText),
    });
  }
  if (input.history?.length) {
    // A message is not only its text. Reasoning, the tool calls the model made,
    // and the results that came back all ride in the window on the next turn,
    // and on a long agentic run they dwarf the prose: counting `content` alone
    // is what made a heavily-worked chat report a few thousand tokens when the
    // real prompt was far larger.
    const convo = input.history.map(historyText).join('\n');
    items.push({
      id: 'conversation',
      source: 'conversation',
      label: `Conversation (${input.history.length} message${input.history.length === 1 ? '' : 's'})`,
      origin: 'chat',
      tokens: estimateTokens(convo),
      pinned: false,
      included: true,
      preview: preview(convo),
    });
  }

  for (const g of input.guidelines) push('guideline', `guideline:${g.path}`, basename(g.path), g.path, g.content);
  for (const a of input.attached) push('attached-file', `file:${a.path}`, basename(a.path), a.path, a.content);
  for (const m of input.memory) push('memory', `mem:${m.id}`, m.title, `memory/${m.scope}`, m.body);
  for (const c of input.connectorSnippets) push('connector', `conn:${c.origin}`, c.label, c.origin, c.body);
  for (const s of input.indexSnippets) push('index-snippet', `idx:${s.path}`, s.relPath, s.path, s.body);

  const totalTokens = items.filter((i) => i.included).reduce((sum, i) => sum + i.tokens, 0);
  return { items, totalTokens, contextWindow: input.contextWindow, contents };
}

/** Render the included items into a system-prompt context block. */
export function renderContextBlock(bundle: ContextBundle, contents: Map<string, string>): string {
  const parts: string[] = [];
  for (const item of bundle.items) {
    if (!item.included) continue;
    // System prompt and conversation are supplied to the model separately;
    // they only appear in the bundle for token accounting, never in the block.
    if (item.source === 'system' || item.source === 'conversation' || item.source === 'skill') continue;
    const body = contents.get(item.id) ?? item.preview;
    const header =
      item.source === 'guideline'
        ? `# Guideline: ${item.label}`
        : item.source === 'memory'
          ? `# Memory: ${item.label}`
          : item.source === 'connector'
            ? `# ${item.label} (${item.origin})`
            : `# File: ${item.origin}`;
    parts.push(`${header}\n${body}`);
  }
  return parts.join('\n\n---\n\n');
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
