import React from 'react';
import type { ChatArtifact } from '../chatArtifacts.js';
import { useStore } from '../store.js';
import { MarkdownSandbox } from './Markdown.js';

export function ChatArtifacts({ artifacts, sessionId }: { artifacts: ChatArtifact[]; sessionId: string }) {
  const sandbox = React.useContext(MarkdownSandbox);
  if (!artifacts.length) return null;
  return <div className="my-2 grid gap-2" aria-label="Response artifacts">
    {artifacts.map(artifact => <button key={artifact.path} type="button" disabled={sandbox}
      className="artifact-card group flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left disabled:opacity-50"
      title={sandbox ? 'Host file previews are unavailable in Sandbox' : `Open ${artifact.path}`}
      onClick={() => useStore.getState().openFilePane(artifact.path, sessionId)}>
      <span className="artifact-card-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold uppercase" aria-hidden>{artifact.filename.split('.').at(-1)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-ink">{artifact.title}</span><span className="block truncate text-[11px] text-ink-soft">{artifact.filename}</span></span>
      <span className="artifact-card-open shrink-0 text-xs" aria-hidden>↗</span>
    </button>)}
  </div>;
}
