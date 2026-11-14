import React from 'react';
import { SidebarCollapseIcon, SidebarExpandIcon } from '../gentleface-icons.js';
import { HoverTip } from './HoverTip.js';

/**
 * The Agents panel's own show/hide control. It stays in the panel's corner
 * whether the panel is open or collapsed, so the way back is where the panel
 * was rather than up in the title bar.
 *
 * An icon button; what it does shows in a hover tooltip, so the button never
 * changes size under the pointer. Open, it sits at the left of the panel's
 * header; collapsed, it heads a strip down the wall's left edge.
 */
export function AgentPanelControls({ show, onToggle, extra }: {
  show: boolean;
  onToggle: () => void;
  /** Panel-only actions that follow the same layout. */
  extra?: React.ReactNode;
}) {
  // Collapsed controls sit against the wall's left edge: their tips open to the right.
  const stacked = !show;
  return (
    <div className="agent-panel-controls" data-stacked={stacked || undefined} data-collapsed={!show || undefined}>
      <HoverTip label={show ? 'Hide agents' : 'Show agents'} side={stacked ? 'right' : 'bottom'}>
        <button
          type="button"
          className="agent-panel-pill"
          aria-label={show ? 'Hide the agent panel' : 'Show the agent panel'}
          aria-pressed={show}
          onClick={onToggle}
        >
          {show ? <SidebarCollapseIcon className="h-4 w-4 shrink-0" /> : <SidebarExpandIcon className="h-4 w-4 shrink-0" />}
        </button>
      </HoverTip>
      {extra}
    </div>
  );
}
