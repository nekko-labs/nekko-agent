// Process trees for the loopback itests (itest-*-daemon.mjs and friends): a
// spawned server starts nekkod, which starts the TS backend, which may start
// more. Ending only the first leaves the rest running on a CI runner.
//
// `treeOptions` puts a child in its own process group on Unix, so `killTree`
// can end the group; on Windows `taskkill /T /F` ends the tree by parent id.
import { execFileSync } from 'node:child_process';

/** Spawn options that let `killTree` end the child and everything under it. */
export const treeOptions = { detached: process.platform !== 'win32', windowsHide: true };

/** End `p` and its descendants, synchronously. Already-exited is fine. */
export function killTree(p) {
  if (!p?.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-p.pid, 'SIGKILL');
  } catch {
    // Gone already, or (Unix) not a group leader: fall back to the child itself.
    try { p.kill('SIGKILL'); } catch { /* gone */ }
  }
}
