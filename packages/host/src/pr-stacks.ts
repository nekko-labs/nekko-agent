import { execFile, execFileSync } from 'node:child_process';
import type { PrActionResult, Session } from '@nekko-agent/shared';
import { getExecutionMode, getSessionWorkspaceIds, parsePrUrl } from '@nekko-agent/shared';
import { createSession, getSession, saveSession } from './sessions.js';
import { getSettings } from './store.js';
import { refreshPrInfo, githubStackRequest } from './pr.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 30_000,
}).trim();

function fetchParent(cwd: string, remote: string, branch: string, ref: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['fetch', '--no-tags', remote, `refs/heads/${branch}:${ref}`], { cwd, windowsHide: true, timeout: 30_000 }, (error) => {
      if (error) reject(new Error('Could not fetch the parent PR. Check Git authentication and repository access, then retry.'));
      else resolve();
    });
  });
}

/** Match configured GitHub remotes only, without accepting arbitrary fetch URLs. */
export function githubRemoteRepo(url: string): string | null {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?(?:\.git)?$/i);
  return match ? match[1].toLowerCase() : null;
}

function activeSession(id: string): Session {
  const s = getSession(id);
  if (!s) throw new Error('Chat not found.');
  if (s.offline || s.incognito || getExecutionMode(s) === 'sandbox') throw new Error('PR stacks require an online, saved chat outside the sandbox.');
  if (s.archivedAt || s.chatType === 'image') throw new Error('Continue from an active coding chat.');
  return s;
}

function parsedPr(url: string) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(url)) throw new Error('Use a GitHub PR URL.');
  const parsed = parsePrUrl(url);
  if (!parsed || !Number.isSafeInteger(parsed.number)) throw new Error('Invalid PR number.');
  return { ...parsed, slug: `${parsed.owner}/${parsed.repo}` };
}

/** Native stacks cannot span a fork, even when the PR URL belongs to the base repo. */
export function requireStackablePr(pr: any, slug: string): void {
  if (pr?.state !== 'open' || pr.merged) throw new Error('The parent PR must still be open. Refresh it or start a normal chat.');
  if (pr.head?.repo?.full_name?.toLowerCase() !== slug.toLowerCase() || pr.base?.repo?.full_name?.toLowerCase() !== slug.toLowerCase()) {
    throw new Error('GitHub stacks require the head and base branches in the same repository. Fork PRs cannot be stacked.');
  }
  if (typeof pr.head.ref !== 'string' || !/^[a-f0-9]{40,64}$/i.test(pr.head.sha)) throw new Error('GitHub did not return a valid parent branch and commit.');
}

/** Pin a selected parent; provisioning and project setup remain lazy on first send. */
export async function continuePrStack(sessionId: string, url: string): Promise<Session> {
  const source = activeSession(sessionId);
  const { slug, number } = parsedPr(url);
  const pr = await githubStackRequest(`repos/${slug}/pulls/${number}`);
  requireStackablePr(pr, slug);
  if (pr.stack) {
    const stack = await githubStackRequest(`repos/${slug}/stacks/${pr.stack.number}`);
    if (stack.pull_requests?.at(-1)?.number !== number) throw new Error('Continue from the top PR of this stack. Another dependent PR is already above this parent.');
  }
  const settings = getSettings();
  for (const id of getSessionWorkspaceIds(source)) {
    const folder = settings.workspaces.find(w => w.id === id);
    if (!folder) continue;
    let remotes: string[];
    try { remotes = git(folder.path, ['remote']).split(/\r?\n/).filter(Boolean); } catch { continue; }
    for (const remote of remotes) {
      const remoteUrl = git(folder.path, ['remote', 'get-url', remote]);
      if (githubRemoteRepo(remoteUrl) !== slug.toLowerCase()) continue;
      git(folder.path, ['check-ref-format', `refs/heads/${pr.head.ref}`]);
      const ref = `refs/nekko/pr-bases/${pr.head.sha}`;
      await fetchParent(folder.path, remote, pr.head.ref, ref);
      if (git(folder.path, ['rev-parse', `${ref}^{commit}`]) !== pr.head.sha) throw new Error('The parent PR changed while fetching. Refresh and try again.');
      activeSession(sessionId);
      const s = createSession(id);
      s.title = `Follow-up to PR #${number}`;
      s.titleAuto = false;
      s.providerId = source.providerId;
      s.modelId = source.modelId;
      s.autoModel = source.autoModel;
      s.autoQuality = source.autoQuality;
      s.thinking = source.thinking;
      s.mode = source.mode;
      s.disabledTools = source.disabledTools ? [...source.disabledTools] : undefined;
      s.executionMode = 'worktree';
      s.gitIsolation = true;
      s.gitStackParent = { workspaceId: id, url: `https://github.com/${slug}/pull/${number}`, branch: pr.head.ref, sha: pr.head.sha };
      saveSession(s);
      return s;
    }
  }
  throw new Error('Select a local project with a GitHub remote matching this PR before continuing it.');
}

/** Register the new PR natively, preserving existing PRs and branches on failure. */
export async function linkPrStack(sessionId: string, url: string): Promise<PrActionResult> {
  try {
    const s = activeSession(sessionId);
    const parent = s.gitStackParent;
    if (!parent || getExecutionMode(s) !== 'worktree') throw new Error('This chat was not started from a parent PR.');
    const a = parsedPr(parent.url), b = parsedPr(url);
    if (a.slug.toLowerCase() !== b.slug.toLowerCase() || a.number === b.number) throw new Error('Select the new dependent PR in the same repository.');
    const checkout = s.gitWorktrees?.[parent.workspaceId];
    if (!checkout) throw new Error('Send the first prompt to prepare this chat’s dependent worktree.');
    const [lower, upper] = await Promise.all([
      githubStackRequest(`repos/${a.slug}/pulls/${a.number}`),
      githubStackRequest(`repos/${b.slug}/pulls/${b.number}`),
    ]);
    requireStackablePr(lower, a.slug);
    requireStackablePr(upper, b.slug);
    if (upper.head.ref !== checkout.branch || git(checkout.path, ['branch', '--show-current']) !== checkout.branch || upper.base.ref !== lower.head.ref) {
      throw new Error('The dependent PR must use this chat’s branch and target its parent PR branch. Update its base on GitHub, then retry.');
    }
    const parentStacks = await githubStackRequest(`repos/${a.slug}/stacks?pull_request=${a.number}`);
    if (!Array.isArray(parentStacks)) throw new Error('Could not read GitHub stack membership.');
    const stack = parentStacks.find((item: any) => item.pull_requests?.some((p: any) => p.number === a.number));
    if (stack) {
      const entries = stack.pull_requests as Array<{ number: number }>;
      const index = entries.findIndex(p => p.number === a.number);
      if (entries[index + 1]?.number === b.number) return { ok: true, message: 'This PR is already linked to its parent stack.', pr: (await refreshPrInfo(url)) ?? undefined };
      if (entries.at(-1)?.number !== a.number) throw new Error('Continue from the top PR of this stack. Another dependent PR is already above this parent.');
      await githubStackRequest(`repos/${a.slug}/stacks/${stack.number}/add`, [b.number]);
    } else {
      await githubStackRequest(`repos/${a.slug}/stacks`, [a.number, b.number]);
    }
    return { ok: true, message: 'Linked as a GitHub PR stack.', pr: (await refreshPrInfo(url)) ?? undefined };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
