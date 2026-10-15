import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../apps/desktop/src/renderer/store';
import { PlanRail } from '../apps/desktop/src/renderer/components/PlanRail';
import { Markdown, MarkdownSession } from '../apps/desktop/src/renderer/components/Markdown';
import '../apps/desktop/src/renderer/styles.css';
// EVIDENCE_ARTIFACT_IMPORT
const sessionId = 'artifact-evidence-session';
const basePath = 'C:/fixture/project';
const text = '## Review complete\n\nThe deliverables are ready for your review.\n\n[Disk audit and cleanup proposal](reports/disk-audit/README.md)\n\n[Implementation checklist](reports/checklist.md)\n\n[Again](reports/disk-audit/README.md)\n\n**Next step:** Open the proposal and review the safe cleanup options.';
const session: any = { id: sessionId, title: 'Review generated deliverables', mode: 'agent', createdAt: 1, updatedAt: 1, workspaceId: 'fixture-workspace', messages: [{ id: 'reply', role: 'assistant', content: text, createdAt: 1 }], attachments: [], queue: [{ text: 'Review the cleanup checklist.' }], agentPlan: [{ id: 'inspect', title: 'Inspect disk usage', status: 'done' }, { id: 'report', title: 'Write proposal and checklist', status: 'done' }, { id: 'review', title: 'Review options before deleting anything', status: 'active' }] };
const opens: any[] = [];
Object.assign(window, { nekko: new Proxy({}, { get: (_, key: string) => key.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }), evidence: { opens, sessionId, basePath } });
useStore.setState({ sessions: [], settings: { workspaces: [{ id: 'fixture-workspace', path: basePath }], providers: [], agent: {}, ui: {} }, openFilePane: (path: string, id: string) => opens.push({ path, sessionId: id }) } as any);
function Fixture() { return <main className="bg-paper text-ink" style={{ height: '100vh', display: 'flex', padding: 16, gap: 16 }}><section data-chat style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 12 }}><h1 className="mb-5 text-sm font-semibold">Review generated deliverables</h1><MarkdownSession.Provider value={sessionId}><Markdown text={text} basePath={basePath} /></MarkdownSession.Provider>{/* EVIDENCE_ARTIFACT_RENDER */}</section><section data-rail style={{ width: '38%', maxWidth: 320, minWidth: 180 }}><PlanRail sessionId={sessionId} session={session} streaming={false} onChangePlan={() => {}} /></section></main>; }
createRoot(document.getElementById('root')!).render(<Fixture />);
