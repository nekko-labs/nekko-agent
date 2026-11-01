import React, { useEffect, useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { ProjectManagementToggles, PullRequestToggles } from '../WorkTrackingToggles.js';

/**
 * Work tracking quick toggles: whether agent chats file an issue per change and
 * link the PR to it, and what of the user's own material goes into them. Saved
 * on Next with explicit values, so this step is the "ask the first time" and the
 * agent never asks again. Including anything is opt-in; skipping leaves the
 * choices unset and the agent asks in the first chat that needs them.
 */
export function WorkTrackingStep({
  commitRef,
}: {
  /** Set to the step's commit action; the wizard runs it on Next. */
  commitRef?: React.MutableRefObject<(() => Promise<void>) | null>;
} = {}) {
  const settings = useStore((s) => s.settings);
  const [pm, setPm] = useState<NonNullable<AppSettings['projectManagement']>>(() => ({
    createIssue: true,
    includePrompt: false,
    includeScreenshots: false,
    includeContext: false,
    ...settings?.projectManagement,
  }));
  const [prs, setPrs] = useState<NonNullable<AppSettings['pullRequests']>>(() => ({
    linkIssue: true,
    includePrompt: false,
    includeScreenshots: false,
    ...settings?.pullRequests,
  }));

  useEffect(() => {
    if (!commitRef) return;
    commitRef.current = async () => {
      const next = await window.nekko.updateSettings({ projectManagement: pm, pullRequests: prs });
      useStore.setState({ settings: next });
    };
    return () => {
      commitRef.current = null;
    };
  }, [commitRef, pm, prs]);

  return (
    <div className="w-full">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Track the work</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-ink-soft">
        When an agent chat opens a PR, it files an issue for the change first and links the PR to it. Choose what of yours goes in them. You can change this later in Settings.
      </p>
      <div className="mt-5 rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
        <h2 className="text-sm font-semibold">Project management</h2>
        <ProjectManagementToggles value={pm} onChange={setPm} />
      </div>
      <div className="mt-3 rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
        <h2 className="text-sm font-semibold">Pull requests</h2>
        <PullRequestToggles value={prs} onChange={setPrs} />
      </div>
    </div>
  );
}
