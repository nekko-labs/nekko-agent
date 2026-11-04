export type ComposerFence = '`' | '```' | null;

/** Only a standalone single backtick opens a short fence; inline code stays inline. */
export function composerFenceAfter(line: string, fence: ComposerFence): ComposerFence {
  if (fence === '`') return /^[ \t]*`[ \t]*\r?$/.test(line) ? null : fence;
  if (fence === '```') return /^\s*```/.test(line) ? null : fence;
  if (/^[ \t]*`[ \t]*\r?$/.test(line)) return '`';
  return /^\s*```/.test(line) ? '```' : null;
}

export function composerFenceAt(text: string): ComposerFence {
  return text.split('\n').reduce<ComposerFence>((fence, line) => composerFenceAfter(line, fence), null);
}

/** A small language-neutral lexer. Tokens are rendered as text, never as HTML. */
export function composerCodeTokens(text: string): { text: string; color?: string }[] {
  const tokens: { text: string; color?: string }[] = [];
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|\b(const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|def|print|true|false|null|None|True|False)\b|\b\d+(?:\.\d+)?\b/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) tokens.push({ text: text.slice(last, index) });
    tokens.push({ text: match[0], color: match[1] ? 'var(--accent-2)' : match[2] ? 'var(--ink-faint)' : match[3] ? 'var(--accent)' : 'var(--accent-2)' });
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens;
}
