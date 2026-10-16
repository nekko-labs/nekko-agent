export interface RailGeometryInput {
  railHeight: number;
  groupTop: number;
  groupHeight: number;
  bodyWidth?: number;
}

/** Coordinates are rail-local. Only the decoration grows; the menu never moves.
 * 40/30/20 are collinear tail stations, not three outward-flaring wings. */
export function railGeometry({ railHeight, groupTop, groupHeight, bodyWidth = 198 }: RailGeometryInput) {
  const height = Math.max(0, Number.isFinite(railHeight) ? railHeight : 0);
  const top = Math.min(height, Math.max(0, Number.isFinite(groupTop) ? groupTop : 0));
  const bottom = Math.min(height, top + Math.max(0, Number.isFinite(groupHeight) ? groupHeight : 0));
  const width = Math.max(0, Number.isFinite(bodyWidth) ? bodyWidth : 198);
  const extension = Math.max(0, Math.min(top, height - bottom) - 2);
  // The shoulder leaves the narrow tail around the CODE heading, 95px
  // above the first button, and reaches full body width at the button.
  // Short windows compress the vertical segments without moving the menu.
  const scale = Math.min(1, extension / 240);
  const bodyLead = 0;
  const shoulder = 95 * scale;
  const tip = 10 * scale;
  const tail = Math.max(0, extension - bodyLead - shoulder - tip);
  const tailWidth = Math.min(40, width);
  const upper: Array<[number, number]> = [
    [0, top - extension],
    [tailWidth / 2, top - extension + tip],
    [tailWidth * 0.75, top - extension + tip + tail / 2],
    [tailWidth, top - bodyLead - shoulder],
    [width, top - bodyLead],
    [width, top],
  ];
  const points: Array<[number, number]> = [
    ...upper,
    ...[...upper].reverse().map(([x, y]): [number, number] => [x, top + bottom - y]),
  ];
  return { width, height, top, bottom, extension, points, polygon: points.map(p => p.join(',')).join(' ') };
}
