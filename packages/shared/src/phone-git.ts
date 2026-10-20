/**
 * Git from a paired phone (IO-33 FA-2): which arguments a phone may send to
 * the `git:*` calls, `workspace:gitStatus` and the PR calls, and what it
 * receives back. The engine is the computer's (packages/shared/src/git.ts);
 * this is the phone's narrow view of it.
 *
 * - A phone names a chat, never a folder: the workspace argument must be
 *   `session:<chatId>`, which the computer resolves to that chat's checkout
 *   (its worktree when isolated). A saved folder's id is refused, so a phone
 *   can't reach a folder no chat of its own works in.
 * - Arguments are rebuilt from the checked fields, so nothing else reaches
 *   the computer's call.
 * - Diffs and file lists are smaller than the desktop's (`PHONE_GIT_VIEW`).
 *   A secret-looking file (the IO-9 rule, `phoneSecretFile`) stays in the
 *   list, so a commit never carries one unseen, but its patch is withheld
 *   (`hidden: true`, counted in `hiddenFiles`).
 * - Commits carry the author's name, never their email; a status's worktree
 *   carries its folder name, never its path on the computer.
 *
 * The daemon has the same rules (crates/nekko-remote/src/phone_git.rs), held
 * to these by the shared cases in crates/nekko-remote/tests/golden/phone-git.json
 * (phone-git.golden.test.ts writes them with UPDATE_GOLDEN=1).
 */

import { phoneSecretFile } from './phone-changes.js';
import { PHONE_PR_VIEW } from './phone-views.js';

/** The limits of a phone's git views. */
export const PHONE_GIT_VIEW = {
  /** Files listed in a diff, a commit or a compare; the rest are counted in `omittedFiles`. */
  files: 100,
  /** Patch lines kept per file; past this the file is `truncated`. */
  linesPerFile: 300,
  /** UTF-8 bytes of patches across a whole answer; files past it keep no patch. */
  totalBytes: 256 * 1024,
  /** Commits in a history or a compare. */
  commits: 100,
  /** Local branches, and remote branches, each. */
  branches: 200,
  /** Checks on a pull request. */
  checks: 100,
  /** A commit's body and a git message, in UTF-16 units. */
  textChars: 4000,
} as const;

/** Read-class git channels: looking only. */
export const PHONE_GIT_READ_CHANNELS = [
  'git:branches',
  'git:compare',
  'git:diff',
  'git:log',
  'git:show',
  'pr:checks',
  'pr:diff',
  'workspace:gitStatus',
] as const;

/**
 * Change-class git channels. `git:commitMessage` changes nothing in the
 * repository but spends the computer's model tokens, so it is a Change too.
 */
export const PHONE_GIT_CHANGE_CHANNELS = [
  'git:commit',
  'git:commitMessage',
  'git:mergeAbort',
  'git:push',
  'git:stage',
  'git:switch',
  'git:unstage',
  'pr:action',
  'pr:create',
] as const;

export const PHONE_GIT_CHANNELS: readonly string[] = [...PHONE_GIT_READ_CHANNELS, ...PHONE_GIT_CHANGE_CHANNELS];

/** The fields a phone may set in each options object. */
export const PHONE_GIT_OPTION_KEYS = {
  diff: ['base', 'path', 'staged'],
  log: ['limit', 'path', 'ref', 'skip'],
  commit: ['message'],
  push: ['setUpstream'],
  switch: ['create'],
  prCreate: ['base', 'body', 'draft', 'title'],
} as const;

/** `pr:action` actions a phone may take. */
export const PHONE_PR_ACTIONS = ['approve', 'close', 'merge', 'reopen'] as const;

/** Fields of a commit a phone receives: no email. */
export const PHONE_COMMIT_VIEW = ['author', 'date', 'parents', 'sha', 'short', 'subject'] as const;
/** Fields of a branch a phone receives. */
export const PHONE_BRANCH_VIEW = ['ahead', 'behind', 'current', 'date', 'gone', 'name', 'remote', 'sha', 'subject', 'upstream'] as const;
/** Fields of a PR check a phone receives. */
export const PHONE_CHECK_VIEW = ['completedAt', 'description', 'link', 'name', 'startedAt', 'state', 'workflow'] as const;

/** Why a phone's git call is refused: the gate turns it into a `PhoneAccessError`. */
export class PhoneGitRefusal extends Error {
  constructor(
    readonly code: 'value-invalid' | 'option-denied',
    readonly detail: string,
  ) {
    super(detail);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const bad = (detail: string) => new PhoneGitRefusal('value-invalid', detail);

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]{1,9}$/;

/** A chat's folder, `session:<chatId>`; any other workspace id is refused. */
function chatFolder(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('session:') || v.length === 'session:'.length || v.length > 200) throw bad('chat folder');
  return v;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw bad(what);
  return v;
}

function prUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 300 || !PR_URL.test(v)) throw bad('pull request url');
  return v;
}

/** An options object (or nothing) with only `keys`, each of the right type. */
function options(v: unknown, keys: readonly string[], what: string, types: Record<string, 'string' | 'boolean' | 'count'>): Obj {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw bad(what);
  const out: Obj = {};
  for (const key of Object.keys(v)) {
    if (!keys.includes(key)) throw new PhoneGitRefusal('option-denied', key);
  }
  for (const key of keys) {
    if (!own(v, key)) continue;
    const value = v[key];
    const type = types[key];
    const ok =
      type === 'string'
        ? typeof value === 'string'
        : type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
    if (!ok) throw bad(key);
    out[key] = value;
  }
  return out;
}

function paths(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 1000) throw bad('paths');
  for (const p of v) if (typeof p !== 'string' || p === '') throw bad('paths');
  return v as string[];
}

/**
 * A phone's git call, checked: the arguments to pass to the computer's call,
 * rebuilt from the checked fields, or a `PhoneGitRefusal`.
 */
export function screenPhoneGit(channel: string, args: unknown[]): unknown[] {
  const ws = () => chatFolder(args[0]);
  switch (channel) {
    case 'workspace:gitStatus':
      if (args[1] !== undefined && typeof args[1] !== 'boolean') throw bad('refresh');
      return [ws(), args[1] === true];
    case 'git:diff':
      return [ws(), options(args[1], PHONE_GIT_OPTION_KEYS.diff, 'diff options', { base: 'string', path: 'string', staged: 'boolean' })];
    case 'git:log':
      return [ws(), options(args[1], PHONE_GIT_OPTION_KEYS.log, 'history options', { limit: 'count', path: 'string', ref: 'string', skip: 'count' })];
    case 'git:show':
      return [ws(), text(args[1], 'commit')];
    case 'git:branches':
    case 'git:commitMessage':
    case 'git:mergeAbort':
      return [ws()];
    case 'git:compare':
      return [ws(), text(args[1], 'base'), text(args[2], 'head')];
    case 'git:stage':
    case 'git:unstage':
      return [ws(), paths(args[1])];
    case 'git:commit': {
      const o = options(args[1], PHONE_GIT_OPTION_KEYS.commit, 'commit options', { message: 'string' });
      if (typeof o.message !== 'string' || o.message.trim() === '') throw bad('message');
      return [ws(), { message: o.message }];
    }
    case 'git:push':
      return [ws(), options(args[1], PHONE_GIT_OPTION_KEYS.push, 'push options', { setUpstream: 'boolean' })];
    case 'git:switch':
      return [ws(), text(args[1], 'branch'), options(args[2], PHONE_GIT_OPTION_KEYS.switch, 'switch options', { create: 'boolean' })];
    case 'pr:create': {
      const o = options(args[1], PHONE_GIT_OPTION_KEYS.prCreate, 'pull request', { base: 'string', body: 'string', draft: 'boolean', title: 'string' });
      if (typeof o.title !== 'string' || o.title.trim() === '') throw bad('title');
      return [ws(), o];
    }
    case 'pr:checks':
    case 'pr:diff':
      return [prUrl(args[0])];
    case 'pr:action': {
      const action = args[1];
      if (typeof action !== 'string' || !(PHONE_PR_ACTIONS as readonly string[]).includes(action)) throw bad('action');
      return [prUrl(args[0]), action];
    }
    default:
      throw bad(channel);
  }
}

/** `s` cut to `n` UTF-16 units, never leaving half of a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const end = s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff ? n - 1 : n;
  return s.slice(0, end);
}

function pickKeys(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (own(o, k)) out[k] = o[k];
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;

function commitView(c: unknown, body: boolean): Obj | null {
  if (!isObj(c)) return null;
  const out = pickKeys(c, PHONE_COMMIT_VIEW);
  if (body && typeof c.body === 'string') out.body = cutText(c.body, PHONE_GIT_VIEW.textChars);
  return out;
}

function commitsView(list: unknown): Obj[] {
  return (Array.isArray(list) ? list : []).map((c) => commitView(c, false)).filter((c): c is Obj => c !== null).slice(0, PHONE_GIT_VIEW.commits);
}

const FILE_KEYS = ['additions', 'binary', 'deletions', 'oldPath', 'path', 'status', 'truncated', 'untracked'] as const;

/**
 * Files of a diff (`patches`) or a compare, capped: at most `files` listed,
 * patches cut to `linesPerFile` lines, and none past `totalBytes`. A
 * secret-looking file is listed with `hidden: true` and no patch.
 */
function filesView(list: unknown, patches: boolean): { files: Obj[]; cut: boolean; omitted: number; hidden: number } {
  const all = (Array.isArray(list) ? list : []).filter((f): f is Obj => isObj(f) && typeof f.path === 'string');
  const files: Obj[] = [];
  let budget: number = PHONE_GIT_VIEW.totalBytes;
  let cut = false;
  let hidden = 0;
  for (const f of all.slice(0, PHONE_GIT_VIEW.files)) {
    const out = pickKeys(f, FILE_KEYS);
    const secret = phoneSecretFile(f.path as string) || (typeof f.oldPath === 'string' && phoneSecretFile(f.oldPath));
    if (secret) {
      out.hidden = true;
      hidden++;
    }
    if (patches) {
      let patch = typeof f.patch === 'string' && !secret ? f.patch : '';
      const lines = patch === '' ? [] : patch.split('\n');
      if (lines.length > PHONE_GIT_VIEW.linesPerFile) {
        patch = lines.slice(0, PHONE_GIT_VIEW.linesPerFile).join('\n');
        out.truncated = true;
      }
      const bytes = utf8(patch);
      if (bytes > budget) {
        patch = '';
        out.truncated = true;
      } else budget -= bytes;
      out.patch = patch;
    }
    if (out.truncated === true) cut = true;
    files.push(out);
  }
  return { files, cut, omitted: Math.max(0, all.length - files.length), hidden };
}

/** A diff-like answer (`{ files, truncated }` plus `extra`) as a phone receives it. */
function diffView(result: Obj, patches: boolean, extra: Obj): Obj {
  const { files, cut, omitted, hidden } = filesView(result.files, patches);
  const out: Obj = { ...extra, files, truncated: result.truncated === true || cut || omitted > 0 };
  if (omitted) out.omittedFiles = omitted;
  if (hidden) out.hiddenFiles = hidden;
  return out;
}

function branchesOf(list: unknown): Obj[] {
  return (Array.isArray(list) ? list : []).filter(isObj).map((b) => pickKeys(b, PHONE_BRANCH_VIEW));
}

function resultView(result: Obj, keys: readonly string[]): Obj {
  const out = pickKeys(result, ['ok', ...keys]);
  if (typeof result.message === 'string') out.message = cutText(result.message, PHONE_GIT_VIEW.textChars);
  return out;
}

const prView = (pr: unknown): Obj | undefined => (isObj(pr) ? pickKeys(pr, PHONE_PR_VIEW) : undefined);

/** What a phone receives for a git channel's result. */
export function phoneGitView(channel: string, result: unknown): unknown {
  if (channel === 'git:log') return commitsView(result);
  if (!isObj(result)) return null;
  switch (channel) {
    case 'workspace:gitStatus': {
      const out = pickKeys(result, ['ahead', 'behind', 'branch', 'dirtyCount', 'head', 'repo', 'updatedAt', 'workspaceId']);
      if (isObj(result.worktree) && typeof result.worktree.name === 'string') out.worktree = { name: result.worktree.name };
      const pr = prView(result.pr);
      if (pr) out.pr = pr;
      return out;
    }
    case 'git:diff':
      return diffView(result, true, {});
    case 'pr:diff':
      return diffView(result, true, typeof result.url === 'string' ? { url: result.url } : {});
    case 'git:show':
      return diffView(result, true, { commit: commitView(result.commit, true) });
    case 'git:compare': {
      const extra = pickKeys(result, ['ahead', 'base', 'behind', 'head', 'mergeBase']);
      extra.commits = commitsView(result.commits);
      return diffView(result, false, extra);
    }
    case 'git:branches': {
      const local = branchesOf(result.local);
      const remote = branchesOf(result.remote);
      const out = pickKeys(result, ['current', 'defaultBranch', 'detached', 'head']);
      out.local = local.slice(0, PHONE_GIT_VIEW.branches);
      out.remote = remote.slice(0, PHONE_GIT_VIEW.branches);
      if (local.length > PHONE_GIT_VIEW.branches) out.omittedLocal = local.length - PHONE_GIT_VIEW.branches;
      if (remote.length > PHONE_GIT_VIEW.branches) out.omittedRemote = remote.length - PHONE_GIT_VIEW.branches;
      return out;
    }
    case 'pr:checks': {
      const items = (Array.isArray(result.items) ? result.items : []).filter(isObj).map((c) => pickKeys(c, PHONE_CHECK_VIEW));
      const out = pickKeys(result, ['checks', 'source', 'url']);
      out.items = items.slice(0, PHONE_GIT_VIEW.checks);
      if (items.length > PHONE_GIT_VIEW.checks) out.omittedItems = items.length - PHONE_GIT_VIEW.checks;
      return out;
    }
    case 'git:commitMessage':
      return pickKeys(result, ['inputTruncated', 'message']);
    case 'git:commit': {
      const out = resultView(result, ['branch']);
      const commit = commitView(result.commit, false);
      if (commit) out.commit = commit;
      return out;
    }
    case 'git:push':
      return resultView(result, ['branch', 'remote', 'upstream']);
    case 'git:switch':
      return resultView(result, ['branch']);
    case 'pr:create':
    case 'pr:action': {
      const out = resultView(result, channel === 'pr:create' ? ['url'] : []);
      const pr = prView(result.pr);
      if (pr) out.pr = pr;
      return out;
    }
    default:
      // git:stage, git:unstage, git:mergeAbort
      return resultView(result, []);
  }
}
