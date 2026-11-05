/** Viewport coordinates for the portalled composer model picker. */
export function pickerPlacement(anchor: { left: number; top: number; bottom: number }, width: number, height: number) {
  const margin = 16;
  const gap = 8;
  const menuWidth = Math.min(416, Math.max(0, width - margin * 2));
  const above = Math.max(0, anchor.top - gap - margin);
  const below = Math.max(0, height - anchor.bottom - gap - margin);
  const opensAbove = above >= below;
  return {
    left: Math.max(margin, Math.min(anchor.left, width - margin - menuWidth)),
    width: menuWidth,
    maxHeight: Math.min(500, opensAbove ? above : below),
    ...(opensAbove ? { bottom: Math.max(margin, height - anchor.top + gap) } : { top: Math.max(margin, anchor.bottom + gap) }),
  };
}
