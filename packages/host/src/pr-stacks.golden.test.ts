import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect, it, vi } from 'vitest';

/**
 * `continuePrStack` and `linkPrStack` as the engine daemon's port
 * (crates/nekko-workspace/src/stacks.rs) must reproduce them: every scenario
 * runs through the real TS functions with git, GitHub, the chats and the
 * settings scripted, and records the answer (or the error) and every call it
 * made, in order. Writes crates/nekko-workspace/tests/golden/stacks.json;
 * fails if it is stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace', 'tests', 'golden', 'stacks.json');

type Answer = unknown;
interface Scenario {
  name: string;
  op: 'continue' | 'link';
  sessionId: string;
  url: string;
  sessions: Record<string, unknown>;
  workspaces: unknown[];
  /** GitHub answers by path; `{ __error }` throws. */
  requests: Record<string, Answer>;
  /** git answers by `cwd|args`; `{ __error }` throws; a missing key throws too. */
  git: Record<string, Answer>;
  fetchFails?: boolean;
  created?: unknown;
  refresh?: unknown;
}

const state = vi.hoisted(() => ({ scenario: null as any, calls: [] as unknown[] }));
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const answer = (v: Answer) => {
  if (v && typeof v === 'object' && '__error' in (v as object)) throw new Error(String((v as { __error: unknown }).__error));
  return clone(v);
};

vi.mock('node:child_process', () => ({
  execFileSync: (_bin: string, args: string[], opts: { cwd: string }) => {
    state.calls.push(['git', opts.cwd, args]);
    const key = `${opts.cwd}|${args.join(' ')}`;
    if (!(key in state.scenario.git)) throw new Error(`Command failed: git ${args.join(' ')}`);
    return answer(state.scenario.git[key]);
  },
  execFile: (_bin: string, args: string[], opts: { cwd: string }, done: (e: Error | null) => void) => {
    state.calls.push(['fetch', opts.cwd, args]);
    done(state.scenario.fetchFails ? new Error('fetch failed') : null);
  },
}));
vi.mock('./pr.js', () => ({
  githubStackRequest: async (path: string, body?: number[]) => {
    state.calls.push(body ? ['request', path, body] : ['request', path]);
    if (!(path in state.scenario.requests)) throw new Error(`no answer for ${path}`);
    return answer(state.scenario.requests[path]);
  },
  refreshPrInfo: async (url: string) => {
    state.calls.push(['refresh', url]);
    return clone(state.scenario.refresh ?? null);
  },
}));
vi.mock('./sessions.js', () => ({
  getSession: (id: string) => clone(state.scenario.sessions[id] ?? null),
  createSession: (workspaceId: string) => {
    state.calls.push(['create', workspaceId]);
    return clone(state.scenario.created);
  },
  saveSession: (s: unknown) => {
    state.calls.push(['save', clone(s)]);
  },
}));
vi.mock('./store.js', () => ({ getSettings: () => clone({ workspaces: state.scenario.workspaces }) }));

const { continuePrStack, linkPrStack } = await import('./pr-stacks.js');

const slug = 'owner/repo';
const url = 'https://github.com/owner/repo/pull/12';
const child = 'https://github.com/owner/repo/pull/13';
const sha = 'a'.repeat(40);
const sha2 = 'b'.repeat(40);
const parentPr = (patch: Record<string, unknown> = {}) => ({
  number: 12,
  state: 'open',
  head: { ref: 'parent', sha, repo: { full_name: slug } },
  base: { ref: 'main', repo: { full_name: slug } },
  ...patch,
});
const childPr = (patch: Record<string, unknown> = {}) => ({
  number: 13,
  state: 'open',
  head: { ref: 'nekko/child', sha: sha2, repo: { full_name: slug } },
  base: { ref: 'parent', repo: { full_name: slug } },
  ...patch,
});
const source = (patch: Record<string, unknown> = {}) => ({
  id: 's_src',
  title: 'Source',
  workspaceId: 'repo',
  executionMode: 'worktree',
  gitIsolation: true,
  providerId: 'p',
  modelId: 'm',
  autoModel: false,
  thinking: 'high',
  mode: 'ask',
  disabledTools: ['browser'],
  messages: [],
  createdAt: 1,
  updatedAt: 2,
  ...patch,
});
const created = { id: 's_new', title: 'New chat', workspaceId: 'repo', executionMode: 'worktree', gitIsolation: true, messages: [], createdAt: 5, updatedAt: 5 };
const repo = [{ id: 'repo', name: 'repo', path: '/repo' }];
const gitOk = (cwd = '/repo', remotes = 'origin\n', urls: Record<string, string> = { origin: 'git@github.com:owner/repo.git\n' }, head = 'parent', rev = `${sha}\n`) => {
  const out: Record<string, Answer> = { [`${cwd}|remote`]: remotes };
  for (const [r, u] of Object.entries(urls)) out[`${cwd}|remote get-url ${r}`] = u;
  out[`${cwd}|check-ref-format refs/heads/${head}`] = '';
  out[`${cwd}|rev-parse refs/nekko/pr-bases/${sha}^{commit}`] = rev;
  return out;
};
const dependent = (patch: Record<string, unknown> = {}) =>
  source({
    gitStackParent: { workspaceId: 'repo', url, branch: 'parent', sha },
    gitWorktrees: { repo: { path: '/dependent', branch: 'nekko/child' } },
    ...patch,
  });
const linkGit = (branch = 'nekko/child\n') => ({ '/dependent|branch --show-current': branch });
const linkRequests = (stacks: unknown = [], lower = parentPr(), upper = childPr()) => ({
  [`repos/${slug}/pulls/12`]: lower,
  [`repos/${slug}/pulls/13`]: upper,
  [`repos/${slug}/stacks?pull_request=12`]: stacks,
  [`repos/${slug}/stacks`]: { number: 3 },
  [`repos/${slug}/stacks/3/add`]: { number: 3 },
});
const prInfo = { url: child, owner: 'owner', repo: 'repo', number: 13, title: 'Child', state: 'open', stack: { number: 3, size: 2 } };

const base = { sessionId: 's_src', url, sessions: { s_src: source() }, workspaces: repo, created };
const continueOk = { ...base, op: 'continue' as const, requests: { [`repos/${slug}/pulls/12`]: parentPr() }, git: gitOk() };
const linkOk = { ...base, op: 'link' as const, url: child, sessions: { s_src: dependent() }, requests: linkRequests(), git: linkGit(), refresh: prInfo };

const SCENARIOS: Scenario[] = [
  { name: 'continue: pins the parent and makes the follow-up chat', ...continueOk },
  { name: 'continue: no such chat', ...continueOk, sessionId: 's_gone' },
  { name: 'continue: offline chat', ...continueOk, sessions: { s_src: source({ offline: true }) } },
  { name: 'continue: incognito chat', ...continueOk, sessions: { s_src: source({ incognito: true }) } },
  { name: 'continue: sandbox chat', ...continueOk, sessions: { s_src: source({ executionMode: 'sandbox' }) } },
  { name: 'continue: archived chat', ...continueOk, sessions: { s_src: source({ archivedAt: 9 }) } },
  { name: 'continue: image chat', ...continueOk, sessions: { s_src: source({ chatType: 'image' }) } },
  { name: 'continue: legacy chat without a mode, unified', ...continueOk, sessions: { s_src: source({ executionMode: undefined, gitIsolation: false }) } },
  { name: 'continue: not a GitHub PR URL', ...continueOk, url: 'https://gitlab.com/owner/repo/pull/12' },
  { name: 'continue: PR zero', ...continueOk, url: 'https://github.com/owner/repo/pull/0' },
  { name: 'continue: a trailing slash and a .git repo name', ...continueOk, url: 'https://github.com/owner/repo.git/pull/12/' },
  { name: 'continue: a PR number past the safe range', ...continueOk, url: 'https://github.com/owner/repo/pull/99999999999999999999' },
  { name: 'continue: closed parent', ...continueOk, requests: { [`repos/${slug}/pulls/12`]: parentPr({ state: 'closed' }) } },
  { name: 'continue: merged parent', ...continueOk, requests: { [`repos/${slug}/pulls/12`]: parentPr({ merged: true }) } },
  {
    name: 'continue: fork parent',
    ...continueOk,
    requests: { [`repos/${slug}/pulls/12`]: parentPr({ head: { ref: 'parent', sha, repo: { full_name: 'fork/repo' } } }) },
  },
  {
    name: 'continue: base repository named in another case',
    ...continueOk,
    requests: { [`repos/${slug}/pulls/12`]: parentPr({ base: { ref: 'main', repo: { full_name: 'Owner/Repo' } } }) },
  },
  {
    name: 'continue: no valid head commit',
    ...continueOk,
    requests: { [`repos/${slug}/pulls/12`]: parentPr({ head: { ref: 'parent', sha: 'xyz', repo: { full_name: slug } } }) },
  },
  { name: 'continue: GitHub refuses the read', ...continueOk, requests: { [`repos/${slug}/pulls/12`]: { __error: 'HTTP 404: Not Found' } } },
  {
    name: 'continue: parent at the top of its stack',
    ...continueOk,
    requests: { [`repos/${slug}/pulls/12`]: parentPr({ stack: { number: 3, size: 2 } }), [`repos/${slug}/stacks/3`]: { pull_requests: [{ number: 10 }, { number: 12 }] } },
  },
  {
    name: 'continue: parent in the middle of a stack',
    ...continueOk,
    requests: { [`repos/${slug}/pulls/12`]: parentPr({ stack: { number: 3, size: 3 } }), [`repos/${slug}/stacks/3`]: { pull_requests: [{ number: 12 }, { number: 14 }] } },
  },
  {
    name: 'continue: a stack with no pull request list',
    ...continueOk,
    requests: { [`repos/${slug}/pulls/12`]: parentPr({ stack: { number: 3, size: 1 } }), [`repos/${slug}/stacks/3`]: {} },
  },
  { name: 'continue: no saved folder for the chat', ...continueOk, workspaces: [] },
  { name: 'continue: a folder that is not a repository', ...continueOk, git: {} },
  { name: 'continue: the only remote is another repository', ...continueOk, git: gitOk('/repo', 'origin\n', { origin: 'https://github.com/other/repo.git' }) },
  { name: 'continue: a look-alike host is not GitHub', ...continueOk, git: gitOk('/repo', 'origin\n', { origin: 'https://github.com.evil.test/owner/repo.git' }) },
  {
    name: 'continue: the second remote matches, CRLF list',
    ...continueOk,
    git: gitOk('/repo', 'fork\r\nupstream\r\n', { fork: 'https://github.com/me/repo.git', upstream: 'ssh://git@github.com/OWNER/REPO/' }),
  },
  { name: 'continue: a .git/ remote does not match', ...continueOk, git: gitOk('/repo', 'origin\n', { origin: 'https://github.com/owner/repo.git/' }) },
  {
    name: 'continue: a supporting folder matches',
    ...continueOk,
    sessions: { s_src: source({ workspaceId: 'docs', supportingWorkspaceIds: ['docs', 'repo', ''] }) },
    workspaces: [{ id: 'docs', name: 'docs', path: '/docs' }, ...repo],
    git: { '/docs|remote': '', ...gitOk() },
  },
  { name: 'continue: a branch name git refuses', ...continueOk, git: { ...gitOk(), '/repo|check-ref-format refs/heads/parent': { __error: 'Command failed: git check-ref-format refs/heads/parent' } } },
  { name: 'continue: the fetch fails', ...continueOk, fetchFails: true },
  { name: 'continue: the parent moved during the fetch', ...continueOk, git: gitOk('/repo', 'origin\n', undefined, 'parent', `${sha2}\n`) },
  {
    name: 'continue: a source without options',
    ...continueOk,
    sessions: { s_src: { id: 's_src', title: 'Bare', workspaceId: 'repo', messages: [], createdAt: 1, updatedAt: 1 } },
    created: { id: 's_new', title: 'New chat', workspaceId: 'repo', gitIsolation: true, messages: [], createdAt: 5, updatedAt: 5 },
  },
  { name: 'continue: null options are copied', ...continueOk, sessions: { s_src: source({ providerId: null, disabledTools: null, autoQuality: 0.5 }) } },

  { name: 'link: creates the stack in dependency order', ...linkOk },
  { name: 'link: no such chat', ...linkOk, sessionId: 's_gone' },
  { name: 'link: a chat not started from a parent', ...linkOk, sessions: { s_src: source() } },
  { name: 'link: a unified chat with a parent', ...linkOk, sessions: { s_src: dependent({ executionMode: 'unified' }) } },
  { name: 'link: the parent itself', ...linkOk, url },
  { name: 'link: another repository', ...linkOk, url: 'https://github.com/other/repo/pull/13' },
  { name: 'link: the same repository in another case', ...linkOk, url: 'https://github.com/Owner/Repo/pull/13', requests: { ...linkRequests(), 'repos/Owner/Repo/pulls/13': childPr() } },
  { name: 'link: not a PR URL', ...linkOk, url: 'https://github.com/owner/repo/issues/13' },
  { name: 'link: no worktree yet', ...linkOk, sessions: { s_src: dependent({ gitWorktrees: undefined }) } },
  { name: 'link: closed parent', ...linkOk, requests: linkRequests([], parentPr({ state: 'closed' })) },
  { name: 'link: a fork dependent', ...linkOk, requests: linkRequests([], parentPr(), childPr({ head: { ref: 'nekko/child', sha: sha2, repo: { full_name: 'fork/repo' } } })) },
  { name: 'link: the dependent uses another branch', ...linkOk, requests: linkRequests([], parentPr(), childPr({ head: { ref: 'other', sha: sha2, repo: { full_name: slug } } })) },
  { name: 'link: the checkout moved to another branch', ...linkOk, git: linkGit('main\n') },
  { name: 'link: the dependent targets main', ...linkOk, requests: linkRequests([], parentPr(), childPr({ base: { ref: 'main', repo: { full_name: slug } } })) },
  { name: 'link: git fails on the checkout', ...linkOk, git: {} },
  { name: 'link: stack membership is not a list', ...linkOk, requests: linkRequests({ message: 'Not Found' }) },
  { name: 'link: extends the top of an existing stack', ...linkOk, requests: linkRequests([{ number: 9, pull_requests: [{ number: 7 }] }, { number: 3, pull_requests: [{ number: 10 }, { number: 12 }] }]) },
  { name: 'link: already linked', ...linkOk, requests: linkRequests([{ number: 3, pull_requests: [{ number: 12 }, { number: 13 }] }]) },
  { name: 'link: the parent is not the top', ...linkOk, requests: linkRequests([{ number: 3, pull_requests: [{ number: 12 }, { number: 14 }] }]) },
  { name: 'link: creating the stack fails', ...linkOk, requests: { ...linkRequests(), [`repos/${slug}/stacks`]: { __error: 'HTTP 422: Validation Failed' } } },
  { name: 'link: no PR state after linking', ...linkOk, refresh: null },
];

it('pr stacks match the daemon golden set', async () => {
  const out = [];
  for (const s of SCENARIOS) {
    state.scenario = s;
    state.calls = [];
    let outcome: Record<string, unknown>;
    try {
      const result = s.op === 'continue' ? await continuePrStack(s.sessionId, s.url) : await linkPrStack(s.sessionId, s.url);
      outcome = { result: clone(result) };
    } catch (e) {
      outcome = { error: (e as Error).message };
    }
    out.push({ ...clone(s), ...outcome, calls: clone(state.calls) });
  }
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(out, null, 2)}\n`);
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
});
