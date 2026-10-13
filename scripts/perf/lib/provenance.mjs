import { execFileSync } from 'node:child_process';

// A base worktree inherits GITHUB_SHA from the workflow's head checkout.
// Record the measured app checkout separately; never substitute the workflow SHA.
export function reportProvenance(appRoot, workflowGit = process.env.GITHUB_SHA ?? null) {
  let git = null;
  try {
    git = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: appRoot, encoding: 'utf8', windowsHide: true, timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Source archives can run the harness without a Git checkout.
  }
  return { git, workflowGit };
}
