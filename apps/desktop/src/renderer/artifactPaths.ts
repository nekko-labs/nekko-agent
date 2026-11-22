import type { Session } from '@nekko-agent/shared';

/**
 * Where the files a chat made really are. Shared by Library's index and a
 * chat's own file cards, so both find the same file.
 */

/** `/`-separated, with `.` and `..` resolved. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  const p = path.replaceAll('\\', '/');
  for (const part of p.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `${p.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

/** Tools that write a whole file, and the argument naming it: Nekko's own, and Claude Code's. */
export const WRITE_TOOLS: Readonly<Record<string, string>> = { write_file: 'path', Write: 'file_path' };
/**
 * Tools that only touch a file: reading, editing or searching it. A chat often
 * checks or fixes a design its helper agent or a script made, and never writes
 * it itself.
 */
export const TOUCH_TOOLS: Readonly<Record<string, string>> = { read_file: 'path', edit_file: 'path', Read: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', Grep: 'path' };

/** The argument naming the file, for a tool that writes or touches one. */
export function toolArg(name: string): string | undefined {
  return Object.hasOwn(WRITE_TOOLS, name) ? WRITE_TOOLS[name] : Object.hasOwn(TOUCH_TOOLS, name) ? TOUCH_TOOLS[name] : undefined;
}

const isAbsolute = (raw: string) => /^(?:[a-z]:[\\/]|\/)/i.test(raw);

/**
 * Every absolute file path a chat's tools named (written, read, edited or
 * searched), in order. A reply that names a file relatively
 * (`nekko-designs/x.html`) means one of these when one ends that way: the chat
 * may have worked in another repo or a worktree, not its own folder.
 */
export function toolPaths(messages: Session['messages']): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.toolCalls ?? []) {
      const arg = toolArg(call.name);
      const named = arg ? call.input?.[arg] : undefined;
      if (typeof named !== 'string' || !isAbsolute(named.trim())) continue;
      const path = normalizePath(named.trim());
      if (/\.[a-z\d]+$/i.test(path)) out.push(path);
    }
  }
  return out;
}

/** The known path a relative name means: the newest one ending in `/<name>`, or null. */
export function knownPathFor(relative: string, known: readonly string[]): string | null {
  if (!known.length || isAbsolute(relative)) return null;
  const tail = `/${normalizePath(relative).toLowerCase()}`;
  if (tail === '/') return null;
  for (let i = known.length - 1; i >= 0; i--) if (known[i].toLowerCase().endsWith(tail)) return known[i];
  return null;
}

/**
 * The same file in the repo's main checkout, for a path inside a git worktree
 * (`repo/.worktrees/<name>/x`, `repo/.claude/worktrees/<name>/x`,
 * `repo/.git/<kind>-worktrees/<name>/x`); null for any other path. A worktree
 * is removed once its branch merges, and what it made lives on in the repo.
 */
export function mainCheckoutPath(path: string): string | null {
  const m = /^(.*?)\/(?:\.worktrees|\.claude\/worktrees|\.git\/[\w-]*worktrees)\/[^/]+\/(.+)$/i.exec(path.replaceAll('\\', '/'));
  return m && m[1] ? `${m[1]}/${m[2]}` : null;
}
