import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from '@nekko-agent/shared';
import { lastGitStatus, refreshGitStatus, subscribeGitStatus } from './gitStatusPoller.js';

/**
 * The git position of a workspace folder, for the sidebar cards.
 *
 * Every card, pane and list showing the same folder or chat shares one poller
 * (`gitStatusPoller.ts`): one read per key every 30 s, plus one when the daemon
 * says it changed git (`git:changed`) or the window comes back from hidden. The
 * host also caches and coalesces per folder.
 *
 * Returns null while the first read is in flight and for a folder that is not a
 * repository, so a caller can render nothing without special-casing either.
 */
export function useGitStatus(workspaceId: string | undefined, checkoutMode?: boolean): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(() => (workspaceId ? lastGitStatus(workspaceId) : null));

  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }
    setStatus(lastGitStatus(workspaceId));
    return subscribeGitStatus(workspaceId, setStatus);
  }, [workspaceId]);

  // A chat that changed how it checks out has another folder: read it now, not at the next poll.
  const mode = useRef(checkoutMode);
  useEffect(() => {
    if (mode.current === checkoutMode) return;
    mode.current = checkoutMode;
    if (workspaceId) refreshGitStatus(workspaceId);
  }, [workspaceId, checkoutMode]);

  return status;
}
