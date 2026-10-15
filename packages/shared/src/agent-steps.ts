/**
 * Making a turn's working steps readable at a glance.
 *
 * A reply is a sequence — think, call a tool, narrate, call another — and
 * collapsing the whole run behind "Worked on 6 steps" hides the one thing worth
 * watching: the order, and what each step actually was. These helpers turn a
 * step into the single line it deserves, so the sequence can be shown without
 * unfolding every payload.
 *
 * Pure and vendor-neutral: reasoning text is reasoning text whether it came from
 * Claude, a local Qwen, or gpt-oss.
 */

/** Words that introduce the conclusion of a thought rather than its exploration. */
const CONCLUSION_RE =
  /^(?:so\b|so,|therefore|thus|in short|overall|the (?:fix|answer|issue|problem|bug|cause|plan)\b|that means|which means|i(?:'ll| will| should| need to| am going to)\b|let(?:'s| me)\b|we (?:should|need to)\b|conclusion|summary|plan:|decision:|okay,? so\b|ok,? so\b)/i;

/** Sentence-ish split that survives abbreviations well enough for a summary. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Strip the markdown a model sprinkles through its reasoning. Line breaks
 * survive (a fenced block becomes one), because they are what separates a
 * heading or a lead-in from the sentence that follows it.
 */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}[^\S\n]+/gm, '')
    .replace(/^[^\S\n]*[-*•][^\S\n]+/gm, '')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

/** Cut to `max` characters on a word boundary, with an ellipsis when cut. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // Back up to the last space, unless that throws away most of the budget
  // (one very long token), in which case cut mid-word rather than show nothing.
  const space = cut.lastIndexOf(' ');
  const kept = space >= max * 0.5 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * One line saying where a thought landed.
 *
 * Reasoning is mostly working-out, and the useful part is the end of it, so the
 * search runs backwards for a sentence that reads as a conclusion ("So the fix
 * is…", "I'll update the parser") and falls back to the last full sentence. The
 * first sentence is the worst possible choice here: it is almost always the
 * model restating the question.
 */
export function summarizeThought(reasoning: string, max = 90): string {
  const text = plain(reasoning ?? '');
  if (!text) return '';
  const parts = sentences(text);
  if (!parts.length) return '';

  // Search backwards; skip trailing fragments too short to mean anything.
  const meaningful = parts.filter((s) => s.length >= 12);
  const pool = meaningful.length ? meaningful : parts;
  for (let i = pool.length - 1; i >= 0; i--) {
    if (CONCLUSION_RE.test(pool[i])) return truncateWords(pool[i].replace(/[.]+$/, ''), max);
  }
  return truncateWords(pool[pool.length - 1].replace(/[.]+$/, ''), max);
}

/** `Repo: …`, `Working directory: …` and the like: setup for a delegation, not what it does. */
const CONTEXT_LINE_RE = /^(?:repo(?:sitory)?|project|workspace|folder|dir(?:ectory)?|working directory|cwd|path|root|branch|base|worktree|github|context|shared instructions?)\s*:/i;
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s,;()"'`]*/g;
const POSIX_PATH_RE = /(?:~|\.{1,2})?\/[^\s,;()"'`]*\/[^\s,;()"'`]*/g;

function leaf(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** The project a delegation is about, as its last path segment or repository name. */
export function delegationProject(text: string): string {
  const repo = /\b(?:github\s+)?([\w.-]+)\/([\w.-]+)\b(?=\s*\))/i.exec(text)?.[2];
  const path = text.match(WINDOWS_PATH_RE)?.[0] ?? text.match(POSIX_PATH_RE)?.[0];
  const fromPath = path ? leaf(path) : '';
  // A path to a file says less than the repository it sits in.
  return /\.[a-z0-9]{1,5}$/i.test(fromPath) && repo ? repo : fromPath || repo || '';
}

/**
 * What a `spawn_agent` call asks for, in one plain sentence, with the
 * project's short name. Context lines (`Repo: C:\…`) and paths are skipped:
 * the sentence that says what to *do* is the one worth showing.
 */
export function summarizeDelegation(input: unknown, max = 90): { what: string; project: string } {
  const inp = (input ?? {}) as Record<string, unknown>;
  const task = typeof inp.task === 'string' ? inp.task.slice(0, 4000) : '';
  const title = typeof inp.title === 'string' ? inp.title.trim().replace(/\s+/g, ' ') : '';
  const project = delegationProject(task);
  // Context lines go; what remains is rejoined so a wrapped sentence stays one sentence.
  const body = plain(task)
    .split(/\n/)
    .filter((line) => !CONTEXT_LINE_RE.test(line.trim()))
    .join('\n')
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s*\n\s*/g, ' '));
  const candidates = body
    .flatMap(sentences)
    .map((s) => s.replace(WINDOWS_PATH_RE, (p) => leaf(p)).replace(POSIX_PATH_RE, (p) => leaf(p)).trim())
    // A sentence that is only a heading or a dangling label says nothing yet.
    .filter((s) => s.length > 3 && !/:$/.test(s));
  const what = candidates[0] ?? title;
  return { what: what ? truncateWords(what, max) : '', project };
}

/**
 * The argument worth showing next to a tool's name: the file it touched, the
 * command it ran, the pattern it searched for. Falls back to the first string
 * argument so an unknown tool (an MCP one, say) still says something.
 */
export function summarizeToolCall(
  call: { name: string; input?: unknown },
  max = 64,
): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  // `ask_user` carries a nested question array rather than a string argument,
  // so the generic "first string" fallback would print a fragment of the first
  // option. The question itself is the only part worth showing.
  if (call.name === 'ask_user') {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = (questions[0] ?? {}) as Record<string, unknown>;
    const text = typeof first.question === 'string' ? first.question : '';
    const more = questions.length - 1;
    if (!text) return '';
    return truncateWords(more > 0 ? `${text} (+${more} more)` : text, max);
  }
  if (call.name === 'spawn_agent') {
    const { what, project } = summarizeDelegation(input, max);
    return what ? truncateWords(project ? `${what} · ${project}` : what, max) : project;
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  // Most specific first: a grep carries both a pattern and a path, and the
  // pattern is the part that says what the step was for.
  const primary =
    pick('command', 'cmd', 'pattern', 'query', 'url', 'file_path', 'path', 'file', 'task', 'title', 'name') ??
    Object.values(input).find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim();
  if (!primary) return '';
  return truncateWords(primary.replace(/\s+/g, ' '), max);
}
