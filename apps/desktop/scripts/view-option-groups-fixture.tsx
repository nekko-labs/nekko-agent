// Synthetic evidence fixture for the View menu's "Open new agents" groups
// (#2399). No host, no network; the screens and desktops are made up in
// view-option-groups-chrome.
import './view-option-groups-chrome';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WallViewOptions } from '../src/renderer/components/WallViewMenu';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import '../src/renderer/styles.css';

(window as any).nekko = new Proxy({}, { get(_t, k: string) { if (k.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } });

function Fixture() {
  const [wall, setWall] = React.useState({ ...DEFAULT_WALL_STATE, layout: { ...DEFAULT_WALL_STATE.layout, mode: 'grid' as const } });
  return <div className="bg-paper" style={{ padding: 24, width: 440, minHeight: 1200 }}>
    {/* The real popover's class, held in place instead of anchored to a trigger. */}
    <div data-shot="view-menu" role="dialog" aria-label="View" className="wall-view-menu" style={{ position: 'static', maxHeight: 'none' }}>
      <WallViewOptions wall={wall as any} setWall={setWall as any} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
