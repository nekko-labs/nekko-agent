import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceCard, StatusIcon, agentStatusOfLane } from '../src/renderer/components/WorkspaceCard';
import { PaneFrame } from '../src/renderer/components/PaneFrame';
import { NumberedAgentIcon } from '../src/renderer/components/NumberedChatIcon';
import { useStore } from '../src/renderer/store';

// Synthetic summaries only. No daemon, providers, local folders, or credentials.
// The exact same fixture is bundled against the archived base and working tree.
const now = 1792051200000;
const cases = [
  { id: 'count0', title: 'Finished response', lane: 'idle', activeWatchCount: 0, note: 'Inactive · 0 active watches' },
  { id: 'count1', title: 'Waiting for CI watch', lane: 'idle', activeWatchCount: 1, note: 'Inactive · 1 active watch' },
  { id: 'working', title: 'Running focused checks', lane: 'working', activeWatchCount: 1, note: 'Working · 1 active watch' },
  { id: 'input', title: 'Needs a decision', lane: 'needs-you', blocked: 'question', activeWatchCount: 0, note: 'Question · needs input' },
  { id: 'error', title: 'Interrupted turn', lane: 'needs-you', blocked: 'interrupted', activeWatchCount: 1, note: 'Interrupted · 1 active watch' },
];
const noop = () => {};
Object.assign(window, { nekko: { getGitStatus: async () => ({ repo: false }) } });
useStore.setState({ providers: [], models: [], prsBySession: {}, sessionCtxEstimate: {}, sessions: [], settings: { theme: 'light', workspaceFolders: [], providers: [] } } as any);
const rows = cases.map((c) => {
  const session = { id: c.id, title: c.title, providerId: 'synthetic', modelId: 'fixture-model', createdAt: now - 600000, updatedAt: now - 60000, lastReplyAt: now - 60000, messageCount: 2, mode: 'guardrails', chatType: 'multimodal', activeWatchCount: c.activeWatchCount };
  // The old two-argument export naturally ignores the third argument.
  const status = (agentStatusOfLane as any)(c.lane, c.blocked, session.activeWatchCount);
  return { ...c, session, status };
});
Object.assign(window, { doneWatcherEvidence: { rows: rows.map(({ session, ...r }) => ({ ...r, status: r.status ?? null, session })), fixture: 'done-watcher-1110-v1', limitations: ['Composer row is a layout equivalent using real StatusIcon and NumberedAgentIcon, not mounted WallComposer/ChatPane.', 'Focused component fixture does not prove production callers forward activeWatchCount.', 'Narrow captures are responsive web renderer evidence, not native mobile or OS chrome.'] } });
const surface = new URLSearchParams(location.search).get('surface');
function Fixture() {
  return <main className="evidence-shell"><header><h1>Agent status</h1><p>Issue #1110 · synthetic summaries · default theme</p></header><div className="evidence-columns">
    {['sidebar', 'wall', 'composer'].filter(s => !surface || s === surface).map(s => <section key={s} data-surface={s}><h2>{s === 'sidebar' ? 'Sidebar · WorkspaceCard' : s === 'wall' ? 'Wall strip · PaneFrame' : 'Composer · glyph equivalent'}</h2>{rows.map((r, i) => <article key={r.id} data-case={r.id} data-resolved-status={r.status ?? 'undefined'}><p className="evidence-note">{r.note}</p>{s === 'sidebar' ? <WorkspaceCard workspace={null} session={r.session as any} terminal={null} status={r.status} isActive={false} now={now} projects={[]} showMetadata={false} onOpen={noop} onClose={noop} /> : s === 'wall' ? <div className="evidence-frame"><PaneFrame pane={{ id: `fixture-${r.id}`, kind: 'chat', refId: r.id }} title={r.title} icon={<><span data-agent-status><StatusIcon status={r.status} /></span><NumberedAgentIcon number={i + 1} /></>} isActive={false} canSplit={() => false} hideSplit onSplit={noop} onClose={noop} onFocus={noop}><div className="evidence-pane-content">Synthetic agent response.</div></PaneFrame></div> : <div className="panel wall-composer evidence-composer"><div className="composer-head flex min-w-0 items-center gap-1.5 border-b border-line px-2 py-1 text-[12px]" data-composer-head><NumberedAgentIcon number={i + 1} /><span className="min-w-0 flex-1 truncate font-medium" data-composer-title>{r.title}</span><StatusIcon status={r.status} /></div><div className="evidence-input">Message this agent…</div></div>}</article>)}</section>)}
  </div><footer>Real status glyphs; composer layout equivalent. No host connection.</footer></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
