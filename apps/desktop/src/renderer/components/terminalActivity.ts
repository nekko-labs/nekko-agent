import type { TerminalInfo } from '@nekko-agent/shared';

/** Terminal-reported metadata is display only, never proof of permission or success. */
export function terminalPresentation(t: TerminalInfo) {
  const a = t.activity;
  const title = a?.title || t.title || 'Terminal';
  const cwd = a?.cwd || t.cwd;
  if (!t.running) return { title, cwd, status: t.exitCode == null ? 'Exited' : t.exitCode === 0 ? 'Exited successfully' : `Exited · code ${t.exitCode}`, tone: t.exitCode ? 'var(--danger)' : 'var(--ink-faint)', detail: '' };
  if (a?.state === 'attention') return { title, cwd, status: 'Needs attention', tone: 'var(--warning)', detail: a.detail || '' };
  if (a?.state === 'running') return { title, cwd, status: 'Working', tone: 'var(--accent)', detail: a.detail || '' };
  if (a?.lastExitCode) return { title, cwd, status: `Command failed · exit ${a.lastExitCode}`, tone: 'var(--danger)', detail: a.detail || '' };
  return { title, cwd, status: a?.state === 'idle' ? 'Ready' : 'Shell open', tone: 'var(--ink-faint)', detail: a?.detail || '' };
}

/** Revalidate even host-reported links before offering an external action. */
export function terminalPrUrl(t: TerminalInfo): string | null {
  const url = t.activity?.pullRequestUrl;
  return url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(url) ? url : null;
}
