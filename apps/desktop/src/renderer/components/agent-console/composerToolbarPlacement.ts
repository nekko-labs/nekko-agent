export interface SelectionAnchor { left: number; right: number; top: number; bottom: number }

/** Measured toolbar geometry, relative to the viewport rather than an agent pane. */
export function composerToolbarPlacement(anchor: SelectionAnchor, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  const gap = 10;
  const center = (anchor.left + anchor.right) / 2;
  const x = Math.max(margin, Math.min(center - width / 2, viewportWidth - width - margin));
  const side = anchor.top - height - gap >= margin ? 'above' : 'below';
  const y = Math.max(margin, Math.min(side === 'above' ? anchor.top - height - gap : anchor.bottom + gap, viewportHeight - height - margin));
  return { x, y, side, pointer: Math.max(14, Math.min(center - x, width - 14)) };
}
