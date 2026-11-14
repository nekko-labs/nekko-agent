import type { ChatMessage } from '@nekko-agent/shared';

/**
 * What a chat knows for turning a reply's references into chips: the GitHub
 * repo its folder pushes to (for a bare `#123`) and the files its agent read
 * or edited (for a bare `RootView.swift:164`). Nothing here reads the disk.
 */
export interface ReplyRefs {
  repo?: { owner: string; repo: string };
  /** Absolute paths, most recently touched first. */
  files: string[];
}

export const NO_REFS: ReplyRefs = { files: [] };

const CODE_EXT = String.raw`swift|kts?|java|tsx?|jsx?|mjs|cjs|rs|go|py|rb|c|h|cc|cpp|hpp|mm?|cs|php|css|scss|html?|vue|svelte|md|json|ya?ml|toml|sh|sql|xml|plist|gradle`;
/** `RootView.swift`, `src/App.tsx:12`, `../a/b.rs:3-9`, `/abs/x.py`: a path, then an optional line or range. */
export const FILE_REF = String.raw`(?:[A-Za-z]:[\\/]|\.{1,2}\/|\/)?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?:${CODE_EXT})(?::\d+(?:-\d+)?)?`;
const FILE_REF_EXACT = new RegExp(String.raw`^${FILE_REF}$`);
/** `#2480` or `owner/repo#12`. */
export const ISSUE_REF_EXACT = /^(?:([A-Za-z0-9][\w.-]*\/[\w.-]+))?#(\d+)$/;

/** A code reference split into its file and line (`164` or `164-166`), or null. */
export function parseFileRef(text: string): { file: string; line?: string } | null {
  const t = text.trim();
  if (!FILE_REF_EXACT.test(t)) return null;
  const m = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(t)!;
  return m[2] ? { file: m[1], line: m[2] } : { file: m[1] };
}

const norm = (p: string) => p.replaceAll('\\', '/');
const absolute = (p: string) => /^(?:[A-Za-z]:[\\/]|\/)/.test(p);

function join(base: string, rel: string): string {
  const parts = norm(base).split('/');
  for (const seg of norm(rel).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Where a referenced file is: an absolute path as written; else a file the
 * agent touched that ends with it (inside the chat folder first); else, for a
 * reference with a folder (or a named output), under the chat folder. Null
 * when none applies, so a bare filename never points at a guess.
 */
export function resolveFileRef(file: string, refs: ReplyRefs, basePath?: string, output = false): string | null {
  if (absolute(file)) return file;
  const want = norm(file).replace(/^\.\//, '');
  const tail = `/${want}`;
  const hits = want.startsWith('../') ? [] : refs.files.filter((f) => norm(f).endsWith(tail));
  const base = basePath ? `${norm(basePath).replace(/\/+$/, '')}/` : '';
  const inside = base ? hits.find((f) => norm(f).startsWith(base)) : undefined;
  if (inside ?? hits[0]) return inside ?? hits[0];
  if (basePath && (want.includes('/') || output)) return join(basePath, want);
  return null;
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];

/** Absolute file paths in the chat's tool calls, newest first, each once. */
export function touchedFiles(messages: readonly ChatMessage[] | undefined): string[] {
  const out = new Set<string>();
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const calls = messages![i].toolCalls;
    if (!calls) continue;
    for (let j = calls.length - 1; j >= 0; j--) {
      const input = calls[j].input ?? {};
      for (const key of PATH_KEYS) {
        const v = input[key];
        if (typeof v === 'string' && absolute(v) && /\.[\w]+$/.test(v)) out.add(v);
      }
    }
  }
  return [...out];
}

/**
 * The GitHub URL a `#N` names: `issues` when the reply calls it an issue, else
 * `pull` (GitHub redirects a PR number to the issue and back). Null without a
 * repo, so `#3` in a list stays text. The slug comes from reply text, so
 * anything that is not a plain `owner/repo` is refused before it becomes an href.
 */
export function issueRefUrl(number: string, slug: string | undefined, issue: boolean, refs: ReplyRefs): string | null {
  const repo = slug ?? (refs.repo ? `${refs.repo.owner}/${refs.repo.repo}` : undefined);
  if (!repo || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || !/^[1-9]\d{0,6}$/.test(number)) return null;
  return `https://github.com/${repo}/${issue ? 'issues' : 'pull'}/${number}`;
}

/** The one repo every PR of the chat is in, when the folder gives none. */
export function onlyRepo(prs: readonly { owner: string; repo: string }[]): ReplyRefs['repo'] {
  const repos = new Set(prs.map((p) => `${p.owner}/${p.repo}`.toLowerCase()));
  return repos.size === 1 ? { owner: prs[0].owner, repo: prs[0].repo } : undefined;
}
