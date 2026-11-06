import type React from 'react';
import { create } from 'zustand';

/**
 * An agent row dragged out of the agents panel toward a zone on the board.
 * The panel starts it; the board draws the row's chip under the pointer and,
 * on a drop, flies that chip into the zone and grows it to the window.
 */
export const AGENT_DRAG_TYPE = 'application/x-nekko-agent';

export interface AgentDrag {
  kind: 'chat' | 'terminal';
  id: string;
  /** A copy of the row as it looked when picked up: the chip in the hand. */
  ghost: HTMLElement;
  from: { left: number; top: number; width: number; height: number };
  /** Where in the row the pointer took hold. */
  grab: { x: number; y: number };
}

export const useAgentDrag = create<{ drag: AgentDrag | null }>(() => ({ drag: null }));

// The browser's own drag picture would sit on top of the chip; a blank one hides it.
const blank = typeof Image === 'undefined' ? null : Object.assign(new Image(), { src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });

export function startAgentDrag(e: React.DragEvent<HTMLElement>, kind: AgentDrag['kind'], id: string): void {
  e.dataTransfer.setData(AGENT_DRAG_TYPE, JSON.stringify({ kind, id }));
  e.dataTransfer.effectAllowed = 'copyMove';
  if (blank) e.dataTransfer.setDragImage(blank, 0, 0);
  const row = e.currentTarget;
  const r = row.getBoundingClientRect();
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('draggable');
  useAgentDrag.setState({ drag: { kind, id, ghost, from: { left: r.left, top: r.top, width: r.width, height: r.height }, grab: { x: e.clientX - r.left, y: e.clientY - r.top } } });
}

export const endAgentDrag = (): void => useAgentDrag.setState({ drag: null });

export const isAgentDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(AGENT_DRAG_TYPE);
