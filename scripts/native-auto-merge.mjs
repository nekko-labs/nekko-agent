// Native PR auto-merge policy. Runs trusted main's copy with an App token;
// never executes PR code, retries failed checks, or bypasses protections.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export function mergeAction(pr, { repo, expectedHead } = {}) {
  if (pr.state !== 'OPEN') return 'ignore';
  if (pr.isDraft || pr.labels.some(label => label.name === 'hold')) return 'disable';
  if (pr.baseRefName !== 'main' || pr.isCrossRepository || pr.headRepositoryOwner?.login !== repo?.split('/')[0]) return 'ignore';
  if (expectedHead && expectedHead !== pr.headRefOid) return 'ignore';
  const gates = pr.statusCheckRollup.filter(check => check.name === 'gate');
  // A stale successful gate must not outrank a pending/failed replacement.
  if (!gates.length || gates.some(check => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS')) return 'disable';
  if (pr.mergeable !== 'MERGEABLE') return 'disable';
  return 'enable';
}

export function applyMergePolicy({ repo, number, expectedHead, run = args => execFileSync('gh', args, { encoding: 'utf8' }) }) {
  const fields = 'state,isDraft,labels,baseRefName,isCrossRepository,headRepositoryOwner,headRefOid,statusCheckRollup,mergeable,autoMergeRequest';
  const pr = JSON.parse(run(['pr', 'view', String(number), '--repo', repo, '--json', fields]));
  const action = mergeAction(pr, { repo, expectedHead });
  if (action === 'disable' && pr.autoMergeRequest) run(['pr', 'merge', String(number), '--repo', repo, '--disable-auto']);
  if (action === 'enable') run(['pr', 'merge', String(number), '--repo', repo, '--auto', '--squash', '--match-head-commit', pr.headRefOid]);
  console.log(`#${number}: ${action}`);
  return action;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const run = args => execFileSync('gh', args, { encoding: 'utf8' });
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const workflow = event.workflow_run;
    if (workflow.event !== 'pull_request' || workflow.head_repository?.full_name !== repo) {
      console.log('Not a same-repository PR CI run; nothing to reconcile.');
    } else {
      const sha = workflow.head_sha;
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid workflow head SHA');
      // workflow_run.pull_requests can be empty; read associated PRs from GitHub.
      const prs = JSON.parse(run(['api', `repos/${repo}/commits/${sha}/pulls?per_page=100`]));
      for (const pr of prs) applyMergePolicy({ repo, number: pr.number, expectedHead: sha, run });
    }
  } else {
    const number = process.env.PR;
    if (!/^\d+$/.test(number ?? '')) throw new Error('Numeric PR is required');
    applyMergePolicy({ repo, number, expectedHead: process.env.EXPECTED_HEAD, run });
  }
}
