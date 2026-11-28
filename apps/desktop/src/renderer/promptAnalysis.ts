/** Local-only draft suggestions and folder mentions for the composer. */

const SECRET_RES: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{20,}/g, 'OpenAI-style API key'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API key'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS access key'],
  [/ghp_[A-Za-z0-9]{30,}/g, 'GitHub token'],
  [/Bearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer token'],
  [/\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}/gi, 'credential'],
];

export function draftSuggestions(text: string) {
  const warnings = SECRET_RES.filter(([pattern]) => text.search(pattern) !== -1)
    .map(([, label]) => `Possible ${label}. Remove it before sending.`);
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    warnings.push('This draft contains an email address. Share it only if needed.');
  }

  const suggestions: Array<{ label: string; description: string; snippet: string }> = [];
  if (!/\b(context|background|reference)\s*:|\b(attached|screenshot|logs?|steps to reproduce)\b|```/i.test(text)) {
    suggestions.push({ label: 'Add context', description: 'Point to a file, example, or the steps that led here.', snippet: 'Context: [add a file or link, an example, or the steps to reproduce]' });
  }
  if (!/\b(scope|constraints?)\s*:|\b(do not|don’t|don't|without|leave .+ unchanged|at most|no more than)\b/i.test(text)) {
    suggestions.push({ label: 'Set boundaries', description: 'Say what is in scope and what should stay unchanged.', snippet: 'Scope: [say what can change and what should stay unchanged]' });
  }
  if (!/\b(verify|verification|acceptance criteria|success criteria|definition of done|run (the )?tests?)\b/i.test(text)) {
    suggestions.push({ label: 'Ask for a check', description: 'Tell the agent how to show the result meets your needs.', snippet: 'Verify the result by [describe the check or expected outcome]. Report anything you couldn’t verify.' });
  }
  return { suggestions, warnings };
}

// --- Project / folder mention detection ------------------------------------
// Powers the composer's "what this will reference" highlight: find where the
// prompt names a known project (by folder name) or a folder path, so the UI can
// underline it and surface the guidelines/specs each one drags into context.

/** A known project the prompt might mention (a workspace folder). */
export interface MentionProject {
  id: string;
  /** Display name of the workspace. */
  name: string;
  /** Last path segment of the workspace folder. */
  base: string;
}

export interface MentionMatch {
  /** Workspace id when the mention maps to a known project, else null. */
  workspaceId: string | null;
  text: string;
  start: number;
  end: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Which known project (if any) a folder path token belongs to. */
function matchWorkspaceForPath(token: string, projects: MentionProject[]): string | null {
  const segs = token.replace(/^[@~]+/, '').split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  if (segs.length === 0) return null;
  for (const p of projects) {
    const key = (p.base || p.name).toLowerCase();
    if (key.length >= 2 && segs.includes(key)) return p.id;
  }
  return null;
}

/**
 * Find, in order and without overlaps, every span of the prompt that names a
 * known project (by name or folder basename) or looks like a folder path. Runs
 * client-side on every keystroke, so it stays cheap and dependency-free.
 */
export function detectFolderMentions(text: string, projects: MentionProject[]): MentionMatch[] {
  const out: MentionMatch[] = [];
  const overlaps = (s: number, e: number) => out.some((m) => s < m.end && e > m.start);
  const push = (workspaceId: string | null, s: number, e: number) => {
    if (e <= s || overlaps(s, e)) return;
    out.push({ workspaceId, text: text.slice(s, e), start: s, end: e });
  };

  // 1) Known projects, matched by name or folder basename as a whole token.
  //    Longest term first so "nekko-dojo" wins over a bare "nekko-agent".
  const terms: Array<{ id: string; term: string }> = [];
  for (const p of projects) {
    for (const term of new Set([p.name, p.base].filter((t): t is string => typeof t === 'string' && t.trim().length >= 3))) {
      terms.push({ id: p.id, term: term.trim() });
    }
  }
  terms.sort((a, b) => b.term.length - a.term.length);
  for (const { id, term } of terms) {
    // Not preceded/followed by a word char, slash, or hyphen — so it's a
    // standalone reference, not a substring or a path segment (rule 2 owns paths).
    const re = new RegExp(`(?<![\\w/\\\\.-])${escapeRegExp(term)}(?![\\w-])`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      push(id, m.index, m.index + m[0].length);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // 2) Explicit folder / path tokens (foo/bar, ./x, ../x, /abs, ~/x, @path).
  //    Requires a real path signal so prose like "and/or" is left alone.
  const pathRe = /(?:@|~\/|\.{1,2}\/|\/)?[\w.-]+(?:[\\/][\w.-]+)*[\\/]?/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(text))) {
    const tok = pm[0];
    if (pm.index === pathRe.lastIndex) pathRe.lastIndex++;
    if (!/[\\/]/.test(tok)) continue; // must contain a separator
    if (/^https?:\/\//i.test(tok)) continue; // skip URLs
    if (pm.index > 0 && text[pm.index - 1] === '/') continue; // mid-URL tail (…://host/…)
    const segs = tok.split(/[\\/]/).filter(Boolean);
    if (segs.every((s) => /^\d+$/.test(s))) continue; // dates / ratios like 2026/07/24
    const hasSignal =
      /^(?:@|~\/|\.{1,2}\/|\/)/.test(tok) || // leading ./ ../ / ~/ @
      /[\\/]$/.test(tok) || // trailing slash
      /\.[a-z0-9]+(?:[\\/]|$)/i.test(tok) || // a dotted filename segment
      segs.length >= 3; // clearly a path (a/b/c)
    if (!hasSignal) continue;
    push(matchWorkspaceForPath(tok, projects), pm.index, pm.index + tok.length);
  }

  return out.sort((a, b) => a.start - b.start);
}
