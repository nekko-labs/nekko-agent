import './pr-deck-titlebar-evidence-setup';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { TitleBar } from '../apps/desktop/src/renderer/components/TitleBar';
import { UpdateProvider } from '../apps/desktop/src/renderer/components/UpdateBanner';
import { PrActionDock } from '../apps/desktop/src/renderer/components/PrCard';
import { useStore } from '../apps/desktop/src/renderer/store';
import '../apps/desktop/src/renderer/styles.css';

const url = 'https://github.com/nekko-labs/nekko-agent/pull/740';
const pr = { url, owner: 'nekko-labs', repo: 'nekko-agent', number: 740, title: 'Open the PR deck upward', state: 'open', isDraft: false, checks: 'passing', reviewDecision: '' } as any;
useStore.setState({ view: 'command', prsBySession: { s: [pr] }, sessions: [] } as any);
// The base revision renders the dock inside the bordered footer strip; the
// working source renders it just above. Everything else is the real component.
const after = (window as any).EVIDENCE_KIND === 'after';

function Footer() {
  const chips = <div className="flex flex-wrap items-center gap-2 text-[12px]">
    <span className="chip">code</span><span className="chip">Claude Opus 4.5 · Anthropic</span><span className="chip">152k / 1m</span><span className="chip">Subscription ($5.50)</span>
  </div>;
  return <>
    {after && <PrActionDock sessionId="s" prs={[pr]} urls={[url]} />}
    <div className="shrink-0 border-t border-line bg-surface px-3 py-1.5" aria-label="Chat actions and information">
      {!after && <PrActionDock sessionId="s" prs={[pr]} urls={[url]} />}
      {chips}
    </div>
  </>;
}

// Stand-in for the portalled Agents toolbar, using the same wrapper class so
// the title-bar band rules apply to it.
function ToolbarStandIn() {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setSlot(document.getElementById('command-titlebar-slot')), []);
  return slot ? createPortal(<div className="wall-toolbar-titlebar flex items-center gap-x-4" data-toolbar-standin>
    <div className="flex items-center gap-2"><button className="btn btn-outline text-[11px]">Focused</button><button className="btn btn-outline text-[11px]">Dynamic</button></div>
    <div className="ml-auto flex items-center gap-2"><button className="btn btn-outline text-[11px]">All</button><button className="btn btn-outline text-[11px]">Monitors</button></div>
  </div>, slot) : null;
}

function Fixture() {
  return <div className="flex h-full w-full flex-col" style={{ background: 'var(--paper)', height: '100vh' }}>
    <UpdateProvider><TitleBar /></UpdateProvider><ToolbarStandIn />
    <div className="flex min-h-0 flex-1">
      <nav style={{ width: 52 }} />
      <main className="flex min-w-0 flex-1 flex-col pb-1.5 pl-[3px] pr-px pt-1">
        <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden" data-board-top style={{ maxWidth: 760 }}>
          <div className="border-b border-line px-3 py-1.5 text-[12px] font-medium">PR panel direction and board spacing</div>
          <div className="min-h-0 flex-1 p-4 text-[13px] text-ink-soft">Done.<br /><br />Sleeping · will check in 60 mins</div>
          <Footer />
        </div>
      </main>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
