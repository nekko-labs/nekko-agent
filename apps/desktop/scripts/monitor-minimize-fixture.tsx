// Synthetic chat start for the Agent Monitor before/after shots: one user
// message ("Testing"), the floating Agent Monitor button and the PlanRail. The
// transcript, rail and styles come from the revision under test; the toggle's
// visibility rule is ChatPane's at that revision (the BASE flag is set by the
// integration script). No real data, no network.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { PlanRail } from '../src/renderer/components/PlanRail';
import { VirtualTranscript } from '../src/renderer/components/agent-console/VirtualTranscript';
import { ControlPanelIcon } from '../src/renderer/icons';
import '../src/renderer/styles.css';

const BASE = __BASE__ as boolean;
(window as any).nekko = { onAgentEvent: () => () => {}, listSessionSummaries: async () => [] };
useStore.setState({ sessions: [], settings: { providers: [], guardrails: [], workspaces: [] } as any } as any);
const session = { id: 's', title: 'Testing', createdAt: 1, updatedAt: 1, messages: [] } as any;
const rows = [{ key: 'u1' }];
const renderRow = () => <div className="flex justify-end"><div className="msg-user">Testing</div></div>;

function Fixture() {
  const [open, setOpen] = useState(false);
  Object.assign(window, { integration: { setOpen } });
  // Base: the toggle always showed. After: only while the panel is minimized.
  const showToggle = BASE || !open;
  return (
    <div data-pane className="flex bg-paper text-ink" style={{ height: '100vh' }}>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 w-full flex-1">
          <VirtualTranscript rows={rows} renderRow={renderRow} estimate={() => 60} cacheKey="s" className={`${open ? 'mx-auto w-full pr-11' : 'mx-auto w-[75%]'} space-y-5`} />
          {showToggle && (
            <button type="button" className={`plan-rail-toggle ${open ? 'is-open' : ''}`} data-plan-toggle onClick={() => setOpen(!open)}>
              <ControlPanelIcon className="h-4 w-4" /><span>Agent Monitor</span>
            </button>
          )}
        </div>
      </section>
      {open && <div className="shrink-0" style={{ width: 280 }}>
        {/* Base PlanRail has no onMinimize prop; passing it there is a no-op. */}
        <PlanRail sessionId="s" session={session} streaming={false} {...({ onMinimize: () => setOpen(false) } as any)} />
      </div>}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
